#!/usr/bin/env bash
set -euo pipefail

app_dir="${APP_DIR:-/var/www/lunar-backend}"
branch="${BRANCH:-main}"
process_name="${PROCESS_NAME:-lunar-backend}"
worker_name="${WORKER_NAME:-lunar-backend-worker}"

cd "$app_dir"

export GIT_TERMINAL_PROMPT=0
git fetch --prune origin "$branch"
git reset --hard "origin/$branch"

npm ci --omit=dev
npm run db:migrate

mkdir -p uploads exports

if pm2 describe "$process_name" >/dev/null 2>&1; then
  pm2 restart "$process_name" --update-env
else
  pm2 start src/server.js --name "$process_name" --time
fi

if pm2 describe "$worker_name" >/dev/null 2>&1; then
  pm2 restart "$worker_name" --update-env
else
  pm2 start src/workers/jobWorker.js --name "$worker_name" --time
fi

pm2 save
pm2 status
