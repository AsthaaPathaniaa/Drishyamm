#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# One-time setup of the PRODUCTION server for the deploy pipeline. Run as root.
# Safe to re-run: every step checks first. Restarts nothing, edits no existing
# file (the .env files and /data/build/docker-compose.prod.yml are only read).
#
#   sudo bash deploy/production/setup-server.sh            user, dirs, compose.env
#   sudo RUNNER_TOKEN=<token> bash deploy/production/setup-server.sh runner
#
# RUNNER_TOKEN: GitHub → Settings → Actions → Runners → New self-hosted runner
# (repo admin only, valid for 1 hour).
#
# Creates:
#   user  deploy (docker group; no password, no SSH login)
#   /data/deploy/                  state: compose.env (0600), lock, history.log
#   /data/deploy/actions-runner/   GitHub runner, labels self-hosted,production
#   /data/backups/deploys/         pre-deploy MySQL dumps
#   package git-lfs                the workflow pulls the frontend's videos with it
# Does NOT create /data/deploy/ENABLED: that switch is turned on by hand after
# the first dry run (deploy/production/README.md).
# ═══════════════════════════════════════════════════════════════════════════
set -Eeuo pipefail

RUNNER_VERSION=2.338.2
RUNNER_SHA256=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40
REPO_URL=https://github.com/systoolspc-dev/Drishyamm
STATE=/data/deploy
LIVE_COMPOSE=/data/build/docker-compose.prod.yml

[[ $EUID == 0 ]] || { echo "run as root" >&2; exit 1; }

if [[ "${1:-}" != runner ]]; then
  # ── user ──
  if ! id deploy >/dev/null 2>&1; then
    useradd --system --create-home --home-dir /home/deploy --shell /bin/bash deploy
    passwd -l deploy >/dev/null
    echo "created user deploy"
  fi
  # docker group = can run containers (root-equivalent on this host, like any
  # docker user). Locked password and no authorized_keys: it can't log in.
  usermod -aG docker deploy

  # ── git-lfs: the app image bundles videos stored in Git LFS ──
  command -v git-lfs >/dev/null || { apt-get install -y git-lfs >/dev/null && echo "installed git-lfs"; }

  # ── dirs ──
  install -d -m 0750 -o deploy -g deploy "$STATE" /data/backups/deploys

  # ── compose.env: the secrets the live compose file has written into it ──
  # The repo's compose file uses ${VAR} for these; the values are copied from the
  # live file so the rendered config stays byte-for-byte what is running.
  if [[ ! -f "$STATE/compose.env" ]]; then
    python3 -I - "$LIVE_COMPOSE" > "$STATE/compose.env.tmp" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
def literal(key):          # KEY: value   (first occurrence)
    m = re.search(rf'^\s+{key}:\s*"?([^"\n]*)"?\s*$', text, re.M)
    return m.group(1).strip() if m else None
def default(key):          # ${KEY:-value}
    m = re.search(r'\$\{' + key + r':-([^}]*)\}', text)
    return m.group(1) if m else None
out = {}
for k in ("MYSQL_ALLOW_EMPTY_PASSWORD", "POSTGRES_PASSWORD", "MINIO_ROOT_PASSWORD",
          "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY"):
    v = literal(k)
    if v is None: sys.exit(f"{k} not found in the live compose file")
    out[k] = v
for k in ("PERSON_TRACKER_SERVICE_TOKEN", "LEGACY_API_KEY"):
    v = default(k)
    if v is not None: out[k] = v
print("# Values copied from /data/build/docker-compose.prod.yml by setup-server.sh.")
print("# Used by scripts/deploy-production.sh (--env-file). Never commit.")
for k, v in out.items(): print(f"{k}={v}")
PY
    install -m 0600 -o deploy -g deploy "$STATE/compose.env.tmp" "$STATE/compose.env"
    rm -f "$STATE/compose.env.tmp"
    echo "wrote $STATE/compose.env ($(grep -c = "$STATE/compose.env") keys)"
  fi
  echo "base setup done. Next: RUNNER_TOKEN=... $0 runner"
  exit 0
fi

# ── runner ──
RDIR="$STATE/actions-runner"
if [[ ! -f "$RDIR/.runner" ]]; then
  : "${RUNNER_TOKEN:?set RUNNER_TOKEN (GitHub → Settings → Actions → Runners → New self-hosted runner)}"
  install -d -m 0750 -o deploy -g deploy "$RDIR"
  tarball="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
  curl -fsSL -o "$RDIR/$tarball" "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/$tarball"
  echo "$RUNNER_SHA256  $RDIR/$tarball" | sha256sum -c -
  tar -C "$RDIR" -xzf "$RDIR/$tarball" && rm -f "$RDIR/$tarball"
  chown -R deploy:deploy "$RDIR"
  "$RDIR/bin/installdependencies.sh" >/dev/null
  sudo -u deploy -H bash -c "cd '$RDIR' && ./config.sh --unattended --url '$REPO_URL' \
    --token '$RUNNER_TOKEN' --name drishyam-prod --labels production --work _work --replace"
fi
cd "$RDIR"
if [[ -f .service ]] && systemctl is-active --quiet "$(cat .service)"; then
  echo "runner service already running"
else
  [[ -f .service ]] || ./svc.sh install deploy
  ./svc.sh start
fi
./svc.sh status | grep -E "Active:|Loaded:" || true
echo "runner installed and running as deploy"
