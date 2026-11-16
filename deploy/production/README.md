# Production deploys

Production (demo.indyatools.com, try/dash/app.drishyam.io, app.drishyam.ai)
deploys from the **`production`** branch. Release = PR `main` → `production`,
merged by a maintainer, then approved in GitHub. Never edit files on the server.

```
PR main → production ──merge──▶ Deploy production (workflow)
                                 waits for approval (environment `production`)
                                 runner [self-hosted, production] on the prod server, user `deploy`
                                 scripts/deploy-production.sh <sha>
                                   checks → build backend+app images (<sha12>)
                                   → compare with live (env, mounts, ports) → MySQL dump
                                   → recreate backend + app → health → record
                                   unhealthy → automatic rollback to the previous images
```

## What a deploy changes, and what it never touches

| Changes | Never touched |
|---|---|
| images `drishyam/backend:<sha12>`, `drishyam/app:<sha12>` | MySQL, Postgres, Qdrant, MinIO, Redis, Kafka and their volumes (`build_*`) |
| containers `drisyam-original-backend`, `drisyam-original-app` (about 10–30 s of API downtime while the backend restarts) | `stream-service` (live video and recording), the AI containers, `head-count`, `activity-monitor` |
| MySQL schema, forward-only, through the backend's Sequelize migrations at start | `/data/build/.env`, `smart-cam-backend/.env`, `smart-cam-ai/.env`, certs, `/data/recordings` |
| | `cloudflared`, `gpu-bridge`, `drisyam-qoe`, `drisyam-zone-guard` (started outside compose) |

The compose project stays **`build`** with the same container names, so the
existing volumes are reused. A different project name would start empty
databases. The preflight (`compare-live.py`) stops any deploy whose env, mounts,
ports or command differ from the running containers. Only the image may change.
A reviewed config change is deployed by re-running with `ALLOW_CONFIG_CHANGE=1`
on the server.

## Server layout

| Path | What |
|---|---|
| `/data/build/` | compose project dir: server-owned `.env` files, `stream-service.yml`, certs, AI configs (unchanged from before the pipeline) |
| `/data/deploy/compose.env` (0600) | secrets the old compose file had written into it (DB/MinIO passwords) |
| `/data/deploy/ENABLED` | kill switch: real deploys refuse to run without it (dry runs still work) |
| `/data/deploy/last-deployed`, `history.log` | what is deployed, and every deploy |
| `/data/deploy/actions-runner/` | runner `drishyam-prod`, service `actions.runner.systoolspc-dev-Drishyamm.drishyam-prod` |
| `/data/backups/deploys/<time>-<sha12>/` | MySQL dump before each deploy (newest 30 kept) |
| `/data/backups/pre-cicd-20261116/` | full backup taken before the pipeline existed (copy on the testing server) |

## Deploy, dry run, roll back

- **Deploy:** merge a PR into `production`, then approve the run (Actions → *Deploy production* → *Review deployments*).
- **Dry run:** Actions → *Deploy production* → *Run workflow*, tick `dry_run`. It builds and compares, and restarts nothing.
- **Roll back:**
  - *Run workflow* with the last good `sha` (`history.log`, or an earlier green run). Images are kept by SHA, so this takes seconds.
  - Then revert the bad PR on `production`, or the next merge brings it back.
  - Schema changes are not undone. Fix forward, or restore the dump from `/data/backups/deploys/`.
- **Back to the images live before the pipeline** (emergency, on the server as root):
  ```bash
  cd /data/build && docker compose -f docker-compose.prod.yml -p build up -d --no-deps smart-cam-backend smart-cam-app
  ```
  The old compose file in `/data/build` still names `prod-20261111-5fd3f1e` / `prod-20261111d`.
- **Stop all deploys:** `rm /data/deploy/ENABLED`.

## First-time setup (done once, 2026-11-16)

1. Root on the server: `bash deploy/production/setup-server.sh`. Creates the `deploy` user, the dirs, and `compose.env`.
2. A repo admin creates a runner token (Settings → Actions → Runners → *New self-hosted runner*), then root runs: `RUNNER_TOKEN=<token> bash deploy/production/setup-server.sh runner`.
3. A repo admin sets up the repo:
   - **Environment `production`** (Settings → Environments → New): *Required reviewers* = the maintainers; *Deployment branches* = selected, `production` only.
   - **Branch protection on `production`** (Settings → Branches → Add rule): require a pull request with 1 approval, require status checks (CI), no force pushes, no deletion.
   - **Actions → General → Fork pull request workflows:** require approval for all outside collaborators.
4. *Run workflow* with `dry_run` ticked. It must end with `✔ dry run OK`.
5. Turn deploys on: as root, `install -o deploy -g deploy -m 0640 /dev/null /data/deploy/ENABLED`.
6. *Run workflow* (not dry run) and approve it. That is the first pipeline deploy.

## Not covered yet

- `stream-service`: still deployed by hand. Recreating it drops every live stream and recording for a few seconds, so it needs its own planned step. The repo's `stream-service.yml` (`readTimeout: 30s`) is not live yet.
- AI: the live AI runs on the office GPU box behind `gpu-bridge`, outside this pipeline.
