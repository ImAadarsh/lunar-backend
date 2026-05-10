#!/usr/bin/env bash
set -euo pipefail

ssh_key="${SSH_KEY:-/Applications/XAMPP/xamppfiles/htdocs/zaam/zaam-api/zaam-erp.pem}"
ssh_user="${SSH_USER:-ubuntu}"
ssh_host="${SSH_HOST:-ec2-13-203-67-189.ap-south-1.compute.amazonaws.com}"
app_dir="${APP_DIR:-/var/www/lunar-backend}"
branch="${BRANCH:-main}"
process_name="${PROCESS_NAME:-lunar-backend}"
worker_name="${WORKER_NAME:-lunar-backend-worker}"

chmod 400 "$ssh_key"

ssh \
  -i "$ssh_key" \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=accept-new \
  -o ConnectTimeout=20 \
  "${ssh_user}@${ssh_host}" \
  "APP_DIR='$app_dir' BRANCH='$branch' PROCESS_NAME='$process_name' WORKER_NAME='$worker_name' bash -s" <<'REMOTE_DEPLOY'
set -euo pipefail

cd "$APP_DIR"

export GIT_TERMINAL_PROMPT=0
git pull --ff-only origin "$BRANCH"

npm ci --omit=dev
npm run build --if-present
npm run db:migrate

mkdir -p uploads exports

if pm2 describe "$PROCESS_NAME" >/dev/null 2>&1; then
  pm2 restart "$PROCESS_NAME" --update-env
else
  pm2 start src/server.js --name "$PROCESS_NAME" --time
fi

if pm2 describe "$WORKER_NAME" >/dev/null 2>&1; then
  pm2 restart "$WORKER_NAME" --update-env
else
  pm2 start src/workers/jobWorker.js --name "$WORKER_NAME" --time
fi

pm2 save
pm2 status
REMOTE_DEPLOY
