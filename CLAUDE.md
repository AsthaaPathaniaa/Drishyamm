# Drishyam: notes for Claude

Video management + smart-camera platform. Backend = Express (`backend/`),
frontend = React/Vite (`frontend/`), AI = FastAPI (`ai/face-service`, plus
`ai/head-count`, `ai/activity-monitor`, `ai/zone-guard`), media = MediaMTX
(`media/stream-service`). Everything runs with `docker compose`. Start with
`README.md` and `docs/dev/00-getting-started.md`.

## Deployment rules (always apply)

- **This machine is the TESTING server**, public at `<testing URL>`
  through a Cloudflare Tunnel (no site password, by the maintainer's choice; Tailscale
  Funnel was turned off on 2026-11-24). Its checkout
  (`/home/systools-pc/Desktop/Projects/Drishyamm`) is auto-deployed from `main`.
  Production (demo.indyatools.com, another machine) deploys only from the `production`
  branch via `deploy-production.yml`, after approval. Runbook: `deploy/production/README.md`.
- **Code reaches a server only through GitHub + the pipeline.** No hand edits on
  servers, no direct pushes to `main`/`production`. Branch → PR → merge → auto-deploy.
- Never commit secrets (`.env*` except examples, `deploy/cloudflared/credentials/*`, tokens, keys).
- Ask before destructive actions (reset --hard, deleting volumes/files, dropping DBs,
  stopping the stack, force-push). Never change production by hand: only through the pipeline.
- Deploy / verify / rollback runbook: skill `drishyam-deploy`.
  CI/CD setup status and open decisions: skill `drishyam-cicd-setup`.
  Human docs: `docs/DEPLOYMENT.md`.
- Never rename compose **service** names; code and env depend on them.
