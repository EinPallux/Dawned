#!/usr/bin/env bash
#
# Dawned — one-time VPS provisioning.
#
#   sudo bash DEPLOY.sh
#
# Idempotent: safe to re-run. Installs Node/pnpm/Postgres/Caddy, hardens the box,
# creates the service user, clones both repos, builds, and starts the services.
# See docs/tech/DEPLOYMENT.md for the full picture.
#
# PRIVATE REPOS: the default HTTPS clone URLs only work for public repositories.
# If the repos are private, either add a read-only deploy key for the `dawned`
# user (docs/tech/DEPLOYMENT.md §"Repository access") and override with SSH URLs:
#   DAWNED_REPO_GAME=git@github.com:EinPallux/Dawned.git bash DEPLOY.sh
# or embed a fine-grained PAT in the HTTPS URL.
set -euo pipefail

# corepack would otherwise interactively prompt before downloading pnpm (it checks
# for a TTY) — a silent hang in an unattended install.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

DOMAIN="${DAWNED_DOMAIN:-play.pathlands.cc}"
REPO_GAME="${DAWNED_REPO_GAME:-https://github.com/EinPallux/Dawned.git}"
REPO_ADMIN="${DAWNED_REPO_ADMIN:-https://github.com/EinPallux/Dawned-Admin.git}"
BRANCH="${DAWNED_BRANCH:-main}"
APP_DIR=/opt/dawned
DATA_DIR=/var/lib/dawned
ETC_DIR=/etc/dawned

log() { printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;31m! %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  warn "DEPLOY.sh must run as root (use sudo)."
  exit 1
fi

log "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y upgrade
apt-get -y install git curl ca-certificates gnupg ufw fail2ban unattended-upgrades \
  postgresql postgresql-contrib debian-keyring debian-archive-keyring apt-transport-https

log "Node.js 22 + pnpm"
if ! command -v node >/dev/null || [[ "$(node -v)" != v22.* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get -y install nodejs
fi
corepack enable
corepack prepare pnpm@10 --activate

log "Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update
  apt-get -y install caddy
fi

log "Firewall and SSH hardening"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable
# Never saw off the branch we're sitting on: disabling password login without an
# installed SSH key would lock a password-only owner out of their own VPS.
# fail2ban protects password logins from brute force in the meantime; add your
# public key to /root/.ssh/authorized_keys and re-run DEPLOY.sh to harden fully.
if [[ -s /root/.ssh/authorized_keys ]]; then
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
  systemctl reload ssh || systemctl reload sshd || true
  echo "  SSH key found — password login disabled (key-only from now on)"
else
  warn "No SSH key in /root/.ssh/authorized_keys — leaving password login ENABLED."
  warn "Recommended later: install a key, then re-run DEPLOY.sh to disable passwords."
fi
systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades || true

log "Service user and directories"
id -u dawned &>/dev/null || useradd -r -m -d "$DATA_DIR" -s /usr/sbin/nologin dawned
install -d -o dawned -g dawned "$APP_DIR" "$DATA_DIR" \
  "$DATA_DIR/published" "$DATA_DIR/assets" "$DATA_DIR/backups"
install -d -m 0750 "$ETC_DIR"

log "PostgreSQL"
systemctl enable --now postgresql
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='dawned'" | grep -q 1; then
  DB_PASSWORD="$(openssl rand -hex 24)"
  sudo -u postgres psql -c "CREATE ROLE dawned LOGIN PASSWORD '${DB_PASSWORD}'"
  sudo -u postgres psql -c "CREATE DATABASE dawned OWNER dawned"
  printf 'DATABASE_URL=postgres://dawned:%s@127.0.0.1:5432/dawned\n' "$DB_PASSWORD" > "$ETC_DIR/db.env"
  chmod 0640 "$ETC_DIR/db.env"
  echo "  created role and database"
else
  echo "  role already present — leaving credentials alone"
fi

PG_VERSION="$(ls /etc/postgresql 2>/dev/null | sort -n | tail -1)"
if [[ -n "$PG_VERSION" ]]; then
  # 1-core/4 GB tuning (docs/tech/DATABASE.md §7).
  cat > "/etc/postgresql/${PG_VERSION}/main/conf.d/dawned.conf" <<'PGCONF'
shared_buffers = 256MB
work_mem = 8MB
maintenance_work_mem = 64MB
max_connections = 40
effective_cache_size = 1GB
PGCONF
  systemctl restart postgresql
fi

log "Cloning repositories"
sudo -u dawned -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash -euo pipefail <<EOSU
  [ -d "$APP_DIR/game" ]  || git clone -b "$BRANCH" "$REPO_GAME"  "$APP_DIR/game"
  [ -d "$APP_DIR/admin" ] || git clone -b "$BRANCH" "$REPO_ADMIN" "$APP_DIR/admin" || \
    git clone "$REPO_ADMIN" "$APP_DIR/admin" || \
    echo "  (admin repo not available — skipping; UPDATE.sh clones it once it exists)"
EOSU

log "Environment files"
if [[ ! -f "$ETC_DIR/game.env" ]]; then
  {
    echo "NODE_ENV=production"
    echo "HOST=127.0.0.1"
    echo "PORT=8081"
    [[ -f "$ETC_DIR/db.env" ]] && cat "$ETC_DIR/db.env"
    echo "SESSION_PEPPER=$(openssl rand -hex 32)"
    echo "OPS_SECRET=$(openssl rand -hex 32)"
    echo "PUBLISHED_DIR=$DATA_DIR/published"
    echo "CLIENT_ORIGIN=https://$DOMAIN"
    echo "LOG_LEVEL=info"
  } > "$ETC_DIR/game.env"
  echo "  wrote $ETC_DIR/game.env"
fi

if [[ ! -f "$ETC_DIR/admin.env" ]]; then
  {
    echo "NODE_ENV=production"
    echo "HOST=127.0.0.1"
    echo "PORT=8082"
    [[ -f "$ETC_DIR/db.env" ]] && cat "$ETC_DIR/db.env"
    echo "OPS_SECRET=$(grep '^OPS_SECRET=' "$ETC_DIR/game.env" | cut -d= -f2-)"
    echo "GAME_OPS_URL=http://127.0.0.1:8081"
    echo "PUBLISHED_DIR=$DATA_DIR/published"
  } > "$ETC_DIR/admin.env"
  echo "  wrote $ETC_DIR/admin.env"
fi
chmod 0640 "$ETC_DIR"/*.env
chown root:dawned "$ETC_DIR"/*.env

log "Building the game"
sudo -u dawned -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash -euo pipefail <<EOSU
  cd "$APP_DIR/game"
  pnpm install --frozen-lockfile
  pnpm build
EOSU

if [[ -d "$APP_DIR/admin" ]]; then
  log "Building the admin panel"
  # The panel consumes @dawned/shared from the SIBLING game checkout
  # (file:../Dawned/packages/shared) — provide the expected sibling name.
  # The game build above already produced packages/shared/dist.
  ln -sfn "$APP_DIR/game" "$APP_DIR/Dawned"
  chown -h dawned:dawned "$APP_DIR/Dawned" 2>/dev/null || true
  sudo -u dawned -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash -euo pipefail <<EOSU || warn "admin build skipped (no code yet)"
    cd "$APP_DIR/admin"
    [ -f package.json ] || exit 0
    pnpm install --frozen-lockfile
    pnpm build
EOSU
fi

log "Database migrations"
# The dawned user cannot read /etc/dawned/*.env — inject DATABASE_URL explicitly
# (read here, as root). A failure aborts the deploy; a server without its tables
# would boot but reject every registration/login.
DATABASE_URL_VALUE="$(grep '^DATABASE_URL=' "$ETC_DIR/game.env" | cut -d= -f2-)"
sudo -u dawned -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 DATABASE_URL="$DATABASE_URL_VALUE" \
  bash -euo pipefail <<EOSU
  cd "$APP_DIR/game"
  pnpm db:migrate
EOSU

log "systemd units and Caddy"
install -m 0644 "$APP_DIR/game/deploy/systemd/dawned-game.service" /etc/systemd/system/
install -m 0644 "$APP_DIR/game/deploy/systemd/dawned-admin.service" /etc/systemd/system/
install -m 0644 "$APP_DIR/game/deploy/systemd/dawned-maintenance.service" /etc/systemd/system/
install -m 0644 "$APP_DIR/game/deploy/systemd/dawned-maintenance.timer" /etc/systemd/system/
sed "s/{{DOMAIN}}/$DOMAIN/g" "$APP_DIR/game/deploy/Caddyfile" > /etc/caddy/Caddyfile

systemctl daemon-reload
systemctl enable --now dawned-game
systemctl enable --now dawned-maintenance.timer
if [[ -f "$APP_DIR/admin/package.json" ]]; then
  systemctl enable --now dawned-admin
else
  echo "  admin service not started (repo has no code yet)"
fi
systemctl reload caddy || systemctl restart caddy

log "Health check"
sleep 3
if curl -fsS --max-time 5 http://127.0.0.1:8081/api/health; then
  echo
  log "DONE — https://$DOMAIN"
  echo "  admin panel (once A0 lands): https://$DOMAIN/admin"
  echo "  logs: journalctl -u dawned-game -f"
else
  warn "game server did not answer — check: journalctl -u dawned-game -n 50"
  exit 1
fi
