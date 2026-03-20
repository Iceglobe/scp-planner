#!/bin/bash
cd "$(dirname "$0")"
git add .
git commit -m "Update SCP planner"
git push
echo "SCP Planner updated."
