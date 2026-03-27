# SCP Planner - Mac Mini Server Setup

The Mac Mini acts as a local server. Customers connect from any browser on the same network.

---

## First-time setup (do this once)

### 1. Install Docker Desktop
Download from https://www.docker.com/products/docker-desktop/ and install.
Open Docker Desktop and let it finish starting before continuing.

### 2. Clone the project
Open Terminal on the Mac Mini:
```bash
git clone <your-github-repo-url> ~/scp-planner
cd ~/scp-planner/Casework/supply-chain-planner
```

### 3. Run the first deployment
```bash
bash server-update.sh
```
This builds the Docker image and starts the app. Takes ~5 minutes the first time.

### 4. Verify it's working
Open a browser on the Mac Mini and go to: http://localhost:8000

### 5. Find the Mac Mini's address for other computers
In Terminal:
```bash
hostname -s
```
Other computers on the same network can access the app at:
`http://<hostname>.local:8000`

Example: if the Mac Mini is named `scp-server`, customers go to `http://scp-server.local:8000`

**Tip:** Give the Mac Mini a memorable name in System Settings > General > Sharing > Computer Name.

---

## Deploying an update

From your **development machine**, push the code:
```bash
bash update.sh
```

Then **SSH into the Mac Mini** and run:
```bash
cd ~/scp-planner/Casework/supply-chain-planner
bash server-update.sh
```

The script will:
- Pull the latest code
- Back up the database automatically (saved in `./backups/`)
- Build the new Docker image
- Run any database migrations safely
- Verify row counts before and after
- Auto-rollback to the previous version if anything goes wrong

---

## Updating the database schema (adding columns / tables)

When you change `backend/models.py`, generate a migration before pushing:

```bash
cd backend
source .venv/bin/activate  # or however your local env is set up
alembic revision --autogenerate -m "describe what changed"
```

Review the generated file in `backend/alembic/versions/`, then push and deploy normally.
The migration runs automatically when the new container starts - old data is preserved.

---

## Auto-start on reboot

Docker Desktop on Mac starts automatically at login. The container has `restart: unless-stopped`,
so it comes back up after any Mac Mini reboot without manual intervention.

To confirm after a reboot:
```bash
docker compose -f ~/scp-planner/Casework/supply-chain-planner/docker-compose.yml ps
```

---

## Backing up data manually

Database backups are created automatically on every `server-update.sh` run in `./backups/`.

For a manual backup at any time:
```bash
cd ~/scp-planner/Casework/supply-chain-planner
docker run --rm \
    -v supply-chain-planner_scp-data:/data \
    -v "$(pwd)/backups":/backup \
    alpine \
    cp /data/scmp.db "/backup/manual_$(date +%Y%m%d_%H%M%S).db"
```

---

## Stopping / restarting

```bash
cd ~/scp-planner/Casework/supply-chain-planner

# Stop
docker compose down

# Start
docker compose up -d

# View logs
docker compose logs -f
```
