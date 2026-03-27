# ── Stage 1: Build React frontend ─────────────────────────────────────────────
FROM node:20-slim AS frontend-builder

WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci --silent

COPY frontend/ ./
# Skip tsc (can hang in CI); vite build is sufficient for production output
RUN npx vite build


# ── Stage 2: Python runtime (bytecode only, no .py source) ────────────────────
FROM python:3.11-slim AS runtime

# gcc needed for some wheels (scipy, etc.) that don't have pre-built binaries
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies before copying source (better layer caching)
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source into a temp location, compile to bytecode, then delete .py
COPY backend/ ./backend/
RUN cd /app/backend \
    && python -m compileall -b -q . \
    && find . -name "*.py" -not -path "./alembic/*" -delete \
    && find . -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true

# Pull in the built frontend — backend main.pyc serves it at /assets + /
COPY --from=frontend-builder /build/frontend/dist /app/frontend/dist

# Data directories — mounted as volumes in production
RUN mkdir -p /app/backend/uploads /app/data

# Expose app port
EXPOSE 8000

WORKDIR /app/backend
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
