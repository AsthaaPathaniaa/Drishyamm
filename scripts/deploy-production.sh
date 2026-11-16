#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Deploy one commit of the `production` branch to the PRODUCTION server.
#
#   scripts/deploy-production.sh <commit-sha> [--dry-run]
#
# Run by .github/workflows/deploy-production.yml on the prod runner (user
# `deploy`), from a checkout of exactly that commit. Runbook and server layout:
# deploy/production/README.md.
#
# What it touches: the images and containers of smart-cam-backend and
# smart-cam-app, nothing else. Datastores, their volumes, stream-service, the AI
# services, cloudflared, gpu-bridge and every .env file are left alone.
#
#   1. checks   kill switch, lock, commit is on origin/production, disk space
#   2. build    drishyam/backend:<sha12>, drishyam/app:<sha12> (skipped if present)
#   3. verify   the new config equals the live containers except the image
#               (env, mounts, ports, command); any difference stops here
#      --dry-run stops here: nothing is restarted
#   4. backup   mysqldump of drishyamvms (the backend's migrations touch only it)
#   5. deploy   recreate the two containers; the backend runs its migrations on start
#   6. health   local backend + app, then the public URL
#               unhealthy → automatic rollback to the previous images
#   7. record   $STATE_DIR/last-deployed and history.log
#
# Env (defaults are the prod server's layout):
#   PROD_DIR=/data/build             compose project dir (server-owned .env, certs, configs)
#   STATE_DIR=/data/deploy           compose.env, ENABLED, lock, history
#   BACKUP_DIR=/data/backups/deploys BACKUP_KEEP=30
#   PUBLIC_URL=https://demo.indyatools.com
#   ALLOW_CONFIG_CHANGE=1            deploy even if step 3 finds differences (reviewed change)
#
# Exit codes: 0 ok · 1 failed (rolled back if it got as far as step 5) · 2 usage
# ═══════════════════════════════════════════════════════════════════════════

main() {
  set -Eeuo pipefail

  local sha_arg="${1:-}" dry_run=0
  [[ "${2:-}" == "--dry-run" ]] && dry_run=1
  if [[ -z "$sha_arg" || "$sha_arg" == -h || "$sha_arg" == --help ]]; then
    echo "usage: scripts/deploy-production.sh <commit-sha> [--dry-run]" >&2
    return 2
  fi

  local root; root="$(git rev-parse --show-toplevel)"; cd "$root"
  PROD_DIR="${PROD_DIR:-/data/build}"
  STATE_DIR="${STATE_DIR:-/data/deploy}"
  local backup_root="${BACKUP_DIR:-/data/backups/deploys}" backup_keep="${BACKUP_KEEP:-30}"
  local public_url="${PUBLIC_URL:-https://demo.indyatools.com}"
  local actor="${DEPLOY_ACTOR:-${GITHUB_ACTOR:-${USER:-unknown}}}"
  COMPOSE_FILE_PATH="$root/deploy/production/docker-compose.prod.yml"

  # ── 1. checks ────────────────────────────────────────────────────────────
  step "1/7 checks"
  if [[ ! -f "$STATE_DIR/ENABLED" && $dry_run == 0 ]]; then
    err "$STATE_DIR/ENABLED is missing: production deploys are switched off on this server."
    err "Dry runs still work. See deploy/production/README.md (first-time setup)."
    return 1
  fi
  [[ -r "$STATE_DIR/compose.env" ]] || { err "missing $STATE_DIR/compose.env"; return 1; }
  exec 9>"$STATE_DIR/lock"
  flock -n 9 || { err "another deploy is running"; return 1; }

  local sha; sha="$(git rev-parse --verify --quiet "${sha_arg}^{commit}")" \
    || { err "unknown commit: $sha_arg"; return 1; }
  [[ "$(git rev-parse HEAD)" == "$sha" ]] || { err "checkout is at $(git rev-parse HEAD), not $sha"; return 1; }
  git fetch --quiet origin production
  git merge-base --is-ancestor "$sha" FETCH_HEAD \
    || { err "$sha is not on origin/production; refusing."; return 1; }
  local free_gb; free_gb=$(df -BG --output=avail /data | tail -1 | tr -dc 0-9)
  (( free_gb >= 20 )) || { err "only ${free_gb}G free on /data"; return 1; }
  local tag="${sha:0:12}"
  echo "    $sha ($(git log -1 --format=%s "$sha"))"
  echo "    image tag $tag · dry run: $([[ $dry_run == 1 ]] && echo yes || echo no)"

  # ── 2. build ─────────────────────────────────────────────────────────────
  step "2/7 build images"
  build_if_missing "drishyam/backend:$tag" "$sha" -f backend/Dockerfile backend
  # Relative bases on purpose: the app's nginx proxies /api, /ai, /hls and /whep
  # on the same origin, so one build serves every hostname (see build-app.sh).
  build_if_missing "drishyam/app:$tag" "$sha" -f frontend/Dockerfile.prod \
    --build-arg VITE_API_BASE_URL=/ --build-arg VITE_AI_BASE_URL=/ai \
    --build-arg VITE_STREAM_SERVICE_WEBRTC_BASE=/whep frontend

  # ── 3. verify ────────────────────────────────────────────────────────────
  step "3/7 compare with the live containers"
  # The rendered config holds every secret: private file, always removed.
  local rendered; rendered="$(umask 077; mktemp "$STATE_DIR/.rendered.XXXXXX")"
  local same=1
  BACKEND_IMAGE_TAG="$tag" APP_IMAGE_TAG="$tag" dc config --format json > "$rendered" \
    || { rm -f "$rendered"; err "docker compose config failed"; return 1; }
  python3 -I "$root/deploy/production/compare-live.py" "$rendered" \
    smart-cam-backend=drisyam-original-backend smart-cam-app=drisyam-original-app || same=0
  rm -f "$rendered"
  if [[ $same == 0 ]]; then
    if [[ "${ALLOW_CONFIG_CHANGE:-0}" == 1 ]]; then
      echo "    differences accepted (ALLOW_CONFIG_CHANGE=1)"
    else
      err "the deploy would change more than the image (above). Nothing was restarted."
      err "If the change is intended and reviewed, re-run with ALLOW_CONFIG_CHANGE=1."
      return 1
    fi
  fi
  if [[ $dry_run == 1 ]]; then
    echo; echo "✔ dry run OK: images built, config matches. Nothing was restarted."
    return 0
  fi

  # ── 4. backup ────────────────────────────────────────────────────────────
  step "4/7 back up MySQL"
  local bdir; bdir="$backup_root/$(date -u +%Y%m%dT%H%M%SZ)-$tag"
  mkdir -p "$bdir"
  docker exec drisyam-original-mysql sh -c \
    'exec mysqldump -uroot ${MYSQL_ROOT_PASSWORD:+-p"$MYSQL_ROOT_PASSWORD"} --single-transaction --quick --routines --triggers --events --set-gtid-purged=OFF drishyamvms' \
    | gzip > "$bdir/mysql-drishyamvms.sql.gz"
  zcat "$bdir/mysql-drishyamvms.sql.gz" | tail -1 | grep -q "Dump completed" \
    || { err "MySQL backup incomplete: $bdir"; return 1; }
  echo "    $bdir ($(du -sh "$bdir" | cut -f1))"
  ls -1dt "$backup_root"/*/ 2>/dev/null | tail -n +"$((backup_keep + 1))" | xargs -r rm -rf --

  # ── 5. deploy ────────────────────────────────────────────────────────────
  step "5/7 recreate smart-cam-backend + smart-cam-app"
  PREV_BACKEND="$(image_tag drisyam-original-backend)"
  PREV_APP="$(image_tag drisyam-original-app)"
  echo "    backend $PREV_BACKEND -> $tag · app $PREV_APP -> $tag"
  ROLLBACK_ARMED=1
  BACKEND_IMAGE_TAG="$tag" APP_IMAGE_TAG="$tag" \
    dc up -d --no-deps --no-build smart-cam-backend smart-cam-app

  # ── 6. health ────────────────────────────────────────────────────────────
  step "6/7 health"
  wait_healthy http://127.0.0.1:5000/api/health/live 300   # includes migrations
  wait_healthy http://127.0.0.1/ 60
  wait_healthy "$public_url/api/health/live" 90
  docker logs --since 10m drisyam-original-backend 2>&1 | grep -iE "migrat" | tail -5 | sed 's/^/    /' || true
  ROLLBACK_ARMED=0

  # ── 7. record ────────────────────────────────────────────────────────────
  step "7/7 record"
  local now; now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'sha=%s\ntag=%s\nsubject=%s\ndeployed_at=%s\nactor=%s\nprevious_backend=%s\nprevious_app=%s\nbackup=%s\n' \
    "$sha" "$tag" "$(git log -1 --format=%s "$sha")" "$now" "$actor" "$PREV_BACKEND" "$PREV_APP" "$bdir" \
    > "$STATE_DIR/last-deployed"
  printf '%s OK       %s by %s (was backend=%s app=%s)\n' "$now" "$sha" "$actor" "$PREV_BACKEND" "$PREV_APP" \
    >> "$STATE_DIR/history.log"
  echo; echo "✔ deployed $sha to production"
}

# ── helpers ────────────────────────────────────────────────────────────────
dc() {
  docker compose -p build --project-directory "$PROD_DIR" -f "$COMPOSE_FILE_PATH" \
    --env-file "$PROD_DIR/.env" --env-file "$STATE_DIR/compose.env" "$@"
}
step() { printf '\n==> %s\n' "$*"; }
err()  { printf '✖ %s\n' "$*" >&2; }
image_tag() { docker inspect -f '{{.Config.Image}}' "$1" | sed 's/^.*://'; }

build_if_missing() {
  local image="$1" sha="$2"; shift 2
  if docker image inspect "$image" >/dev/null 2>&1; then
    echo "    $image already built"
  else
    echo "    building $image"
    docker build --quiet --label "org.opencontainers.image.revision=$sha" -t "$image" "$@" > /dev/null
  fi
}

wait_healthy() {
  local url="$1" limit="$2" waited=0
  until curl -fsS -o /dev/null --max-time 5 "$url"; do
    if (( waited >= limit )); then err "unhealthy after ${limit}s: $url"; return 1; fi
    sleep 5; waited=$((waited + 5))
  done
  echo "    ok  $url  (${waited}s)"
}

# Any failure after the containers were recreated puts the previous images back.
# shellcheck disable=SC2317  # invoked by the ERR trap
on_fail() {
  local now; now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [[ "${ROLLBACK_ARMED:-0}" == 1 ]]; then
    ROLLBACK_ARMED=0
    err "deploy failed after the restart: rolling back to backend=$PREV_BACKEND app=$PREV_APP"
    docker logs --tail 40 drisyam-original-backend >&2 || true
    if BACKEND_IMAGE_TAG="$PREV_BACKEND" APP_IMAGE_TAG="$PREV_APP" \
         dc up -d --no-deps --no-build smart-cam-backend smart-cam-app \
       && wait_healthy http://127.0.0.1:5000/api/health/live 300; then
      err "rolled back; production is on the previous images. Schema changes (if any) stay applied."
      echo "$now FAILED   rolled back to backend=$PREV_BACKEND app=$PREV_APP" >> "$STATE_DIR/history.log"
    else
      err "ROLLBACK FAILED: production may be down. Runbook: deploy/production/README.md"
      echo "$now FAILED   ROLLBACK FAILED" >> "$STATE_DIR/history.log"
    fi
  else
    err "deploy failed before anything was restarted. Production is unchanged."
  fi
}

trap on_fail ERR
main "$@"
exit $?
