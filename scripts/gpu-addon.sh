#!/usr/bin/env bash
# gpu-addon.sh — pick the GPU add-on compose file for THIS host and record it
# in .env as COMPOSE_FILE, so `docker compose` (by hand or from deploy.sh) uses
# the GPU the host actually has.
#
#   scripts/gpu-addon.sh            # auto-detect (or GPU_ADDON from env / .env)
#   scripts/gpu-addon.sh nvidia     # force: nvidia | vaapi | none | auto
#
# auto:
#   nvidia  `nvidia-smi` lists a GPU AND Docker can hand it to containers
#           (an `nvidia` runtime or a CDI spec)    -> docker-compose.nvidia.yml
#   vaapi   else, a /dev/dri render node exists    -> docker-compose.vaapi.yml
#   none    else                                    -> docker-compose.yml only
#
# Only the add-on entry in COMPOSE_FILE is changed; other entries (e.g.
# deploy/testing/docker-compose.testing.yml) keep their place. Pin a choice
# with GPU_ADDON=nvidia|vaapi|none in .env.
#
# Prints the resulting COMPOSE_FILE on stdout (deploy.sh exports it); the
# decision goes to stderr. Run by deploy.sh after checking out the commit, so a
# commit without the add-on files (a rollback to before they existed) gets them
# taken out of COMPOSE_FILE: that commit's docker-compose.yml has `gpus: all`
# itself, and compose refuses a COMPOSE_FILE naming a missing file.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ENV_FILE=.env
ADDONS=(docker-compose.nvidia.yml docker-compose.vaapi.yml)

say() { echo "    gpu: $*" >&2; }
env_value() { [[ -f $ENV_FILE ]] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 || true; }

mode="${1:-${GPU_ADDON:-$(env_value GPU_ADDON)}}"
mode="${mode:-auto}"

# Command output is captured before it is searched: under pipefail,
# `cmd | grep -q/-m1` fails at random when grep stops reading early and cmd
# dies on SIGPIPE (deploy.sh hit exactly that), which here would drop the
# NVIDIA add-on and restart the AI without its GPU.
nvidia_gpu() {
  local out
  command -v nvidia-smi >/dev/null 2>&1 || return 1
  out="$(nvidia-smi -L 2>/dev/null)" || return 1
  grep -m1 '^GPU ' <<<"$out"
}
docker_has_nvidia() {
  local runtimes
  runtimes="$(docker info --format '{{json .Runtimes}}' 2>/dev/null || true)"
  [[ $runtimes == *'"nvidia"'* ]] && return 0
  compgen -G '/etc/cdi/nvidia*.y*ml' >/dev/null || compgen -G '/var/run/cdi/nvidia*.y*ml' >/dev/null
}
render_nodes() { compgen -G '/dev/dri/renderD*' | tr '\n' ' '; }

case "$mode" in
  auto)
    if gpu="$(nvidia_gpu)" && docker_has_nvidia; then
      pick=nvidia; why="${gpu%% (UUID*}"
    elif nodes="$(render_nodes)" && [[ -n $nodes ]]; then
      pick=vaapi; why="render nodes: ${nodes% }"
      [[ -n "$(nvidia_gpu || true)" ]] && why="$why (an NVIDIA GPU is present but Docker has no NVIDIA runtime: install the NVIDIA Container Toolkit)"
    else
      pick=none; why="no NVIDIA GPU, no /dev/dri render node"
    fi ;;
  nvidia|vaapi|none) pick=$mode; why="GPU_ADDON=$mode" ;;
  *) echo "gpu-addon: unknown mode '$mode' (auto | nvidia | vaapi | none)" >&2; exit 2 ;;
esac

addon=""
[[ $pick != none ]] && addon="docker-compose.$pick.yml"
if [[ -n $addon && ! -f $addon ]]; then
  why="$why; this commit has no $addon, so none"
  pick=none; addon=""
fi

current="$(env_value COMPOSE_FILE)"
current="${current:-docker-compose.yml}"
IFS=: read -ra parts <<<"$current"

# Drop any add-on, then put the chosen one right after the base file.
new=()
base_seen=0
for f in "${parts[@]}"; do
  [[ -z $f ]] && continue
  skip=0; for a in "${ADDONS[@]}"; do [[ $f == "$a" ]] && skip=1; done
  (( skip )) && continue
  new+=("$f")
  if [[ $f == docker-compose.yml ]]; then
    base_seen=1
    [[ -n $addon ]] && new+=("$addon")
  fi
done
if (( ! base_seen )); then
  say "COMPOSE_FILE ($current) doesn't list docker-compose.yml; leaving it as is"
  echo "$current"
  exit 0
fi
value="$(IFS=:; echo "${new[*]}")"

say "$pick ($why) -> COMPOSE_FILE=$value"

if [[ ! -f $ENV_FILE ]]; then
  say "no $ENV_FILE here; not saving it (copy .env.example to .env first)"
elif [[ "$(env_value COMPOSE_FILE)" != "$value" ]]; then
  if grep -q '^COMPOSE_FILE=' "$ENV_FILE"; then
    tmp="$(mktemp)"
    awk -v v="$value" '/^COMPOSE_FILE=/{print "COMPOSE_FILE=" v; next} {print}' "$ENV_FILE" >"$tmp"
    cat "$tmp" >"$ENV_FILE"   # rewrite in place: keeps the file's owner and mode
    rm -f "$tmp"
  else
    printf '\n# GPU add-on for this host, set by scripts/gpu-addon.sh\nCOMPOSE_FILE=%s\n' "$value" >>"$ENV_FILE"
  fi
  say "saved to $ENV_FILE"
fi

echo "$value"
