#!/usr/bin/env bash
# Deploy Lunar Security API to EC2 (git pull on server).
#
# Public API: https://lunar.endeavourdigital.cloud/api/v1
# Health:     https://lunar.endeavourdigital.cloud/health  (not /api/health)
#
# The web portal (separate host) must use BACKEND_API_BASE over the VPC private IP;
# deploy_web.sh resolves that automatically.
#
# Usage (from backend/):
#   ./deploy_backend.sh
#   DEPLOY_MODE=rsync ./deploy_backend.sh   # fallback if git pull fails on server
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

deploy_mode="${DEPLOY_MODE:-git}"
ssh_key="${SSH_KEY:-/Applications/XAMPP/xamppfiles/htdocs/zaam/zaam-api/zaam-erp.pem}"
ssh_user="${SSH_USER:-ubuntu}"
ssh_host="${SSH_HOST:-ec2-13-203-67-189.ap-south-1.compute.amazonaws.com}"
app_dir="${APP_DIR:-/var/www/lunar-backend}"
branch="${BRANCH:-main}"
process_name="${PROCESS_NAME:-lunar-backend}"
worker_name="${WORKER_NAME:-lunar-backend-worker}"
api_port="${PORT:-4000}"
portal_origin="${PORTAL_ORIGIN:-https://lunar-web.endeavourdigital.cloud}"

ssh_target="${ssh_user}@${ssh_host}"
ssh_opts=(-i "$ssh_key" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

remote() {
  ssh "${ssh_opts[@]}" "$ssh_target" "$@"
}

ensure_portal_cors() {
  remote "test -f '${app_dir}/.env' || { echo 'ERROR: missing ${app_dir}/.env on server'; exit 1; }
grep -q 'lunar-web.endeavourdigital.cloud' '${app_dir}/.env' 2>/dev/null || \
  sed -i 's|^CORS_ORIGINS=\\(.*\\)|CORS_ORIGINS=\\1,${portal_origin}|' '${app_dir}/.env' || true"
}

remote_post_deploy_checks() {
  remote "set -e
cd '${app_dir}'
curl -fsS --connect-timeout 10 'http://127.0.0.1:${api_port}/health' | grep -q '\"status\":\"ok\"' || { echo 'GET /health failed'; exit 1; }
curl -fsS --connect-timeout 10 'http://127.0.0.1:${api_port}/ready' | grep -q '\"status\":\"ready\"' || { echo 'GET /ready failed'; exit 1; }
code=\$(curl -sS -o /tmp/api_login.json -w '%{http_code}' --connect-timeout 15 -X POST 'http://127.0.0.1:${api_port}/api/v1/auth/login' -H 'Content-Type: application/json' -d '{\"email\":\"deploy-probe@invalid.local\",\"password\":\"invalid\"}')
test \"\$code\" = '401' || { echo \"POST /api/v1/auth/login expected 401, got \$code: \$(cat /tmp/api_login.json)\"; exit 1; }
echo 'Post-deploy checks OK (/health, /ready, /api/v1/auth/login).'
pm2 status
df -h / | tail -1"
}

deploy_git() {
  chmod 400 "$ssh_key"
  log "Deploying backend via git on ${ssh_target}…"
  ssh \
    "${ssh_opts[@]}" \
    "$ssh_target" \
    "APP_DIR='$app_dir' BRANCH='$branch' PROCESS_NAME='$process_name' WORKER_NAME='$worker_name' API_PORT='$api_port' bash -s" <<'REMOTE_GIT'
set -euo pipefail

if [ ! -d "$APP_DIR" ]; then
  echo "ERROR: $APP_DIR does not exist. Clone the repo there first." >&2
  exit 1
fi

cd "$APP_DIR"
export GIT_TERMINAL_PROMPT=0

if [ -e deploy_backend.sh ] && ! git ls-files --error-unmatch deploy_backend.sh >/dev/null 2>&1; then
  rm -f deploy_backend.sh
fi

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
REMOTE_GIT
  ensure_portal_cors
  remote "pm2 restart '$process_name' '$worker_name' --update-env 2>/dev/null || true"
  remote_post_deploy_checks
  log "Backend deploy complete. API: https://lunar.endeavourdigital.cloud/api/v1"
}

deploy_rsync() {
  chmod 400 "$ssh_key"
  log "DEPLOY_MODE=rsync — syncing local backend to ${ssh_target}…"
  if [[ ! -f package-lock.json ]]; then
    die "package-lock.json missing. Run npm install in backend/ first."
  fi
  npm ci --omit=dev
  remote "sudo mkdir -p '${app_dir}' && sudo chown -R \"\$USER\":\"\$USER\" '${app_dir}'"
  rsync -az --delete \
    --exclude .git \
    --exclude .env \
    --exclude uploads \
    --exclude exports \
    --exclude .DS_Store \
    -e "ssh ${ssh_opts[*]}" \
    ./ "${ssh_target}:${app_dir}/"
  remote "cd '${app_dir}' && npm ci --omit=dev && npm run build --if-present && npm run db:migrate && mkdir -p uploads exports"
  remote "if pm2 describe '${process_name}' >/dev/null 2>&1; then pm2 restart '${process_name}' --update-env; else pm2 start src/server.js --name '${process_name}' --time; fi"
  remote "if pm2 describe '${worker_name}' >/dev/null 2>&1; then pm2 restart '${worker_name}' --update-env; else pm2 start src/workers/jobWorker.js --name '${worker_name}' --time; fi"
  remote "pm2 save"
  ensure_portal_cors
  remote "pm2 restart '$process_name' '$worker_name' --update-env 2>/dev/null || true"
  remote_post_deploy_checks
  log "Backend rsync deploy complete."
}

case "$deploy_mode" in
  git) deploy_git ;;
  rsync) deploy_rsync ;;
  *) die "Unknown DEPLOY_MODE=${deploy_mode} (use git or rsync)" ;;
esac
