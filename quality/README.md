# AutoEvo community quality (serverless)

**Archived.** Do not deploy this as a public endpoint. `*.workers.dev` is not reliably reachable from mainland China, so a community snapshot hosted here would not reach the users who need it. Keep the code; do not enable `communityQualityFilter` / `communityReports` until a reachable write+read host exists.

Cloudflare Worker + D1 + R2. There is no always-on process.

DSH traffic is the read path. Every client hits the **same** snapshot URL, so a Cache Rule or public R2 object can absorb it. Writes are one batched POST per finished install (or one startup retry).

```text
GET  /v1/quality/assessments     ← shared snapshot (CDN / R2)
POST /v1/quality/observations    ← one batch, id is idempotent
GET  /health
```

A single failure never becomes `junk`. Negative classes need several independent (repository, commit, versions, stage, day) samples. Raw rows expire after 45 days; only aggregates stay in the snapshot.

## Deploy (first time: Worker + D1 only)

In PowerShell, from this directory:

```powershell
cd quality
npm install
npx wrangler login
npx wrangler d1 create autoevo-quality
```

Copy the printed `database_id` into `wrangler.toml` (`replace-with-d1-id`). Then:

```powershell
npx wrangler d1 execute autoevo-quality --remote --file=schema.sql
npx wrangler deploy
```

Smoke-check the URL wrangler prints (`https://autoevo-quality.<subdomain>.workers.dev`):

```powershell
curl https://autoevo-quality.<subdomain>.workers.dev/health
curl https://autoevo-quality.<subdomain>.workers.dev/v1/quality/assessments
```

`assessments` starts as `{ "assessments": [] }`. That is fine until clients POST observations and the daily cron rebuilds the snapshot.

R2 is optional. Add the `[[r2_buckets]]` block and `npx wrangler r2 bucket create autoevo-quality-snapshot` only when you want GET to skip rebuilding from D1. For public DSH-scale reads, put a Cache Rule on `GET /v1/quality/assessments` (eligible, edge TTL 1 day) or serve the R2 object `v1/quality/assessments.json` directly.

## Point AutoEvo at it

```yaml
communityQualityFilter: true
communityReports: true
communityQualityEndpoint: https://autoevo-quality.<account>.workers.dev
communityQualityTimeoutMs: 2000
```

Use a custom HTTPS hostname in production. The client GETs the snapshot on the first read of each UTC day, writes `stateDir/community-quality/assessments.json`, and reuses that file across DSH restarts until the next day. Writes stay one batched POST after install.

Do not turn this on by default until the GET path is on CDN/R2. A Worker invocation per user per resolve will not survive DSH-scale traffic on the free 100k/day plan.
