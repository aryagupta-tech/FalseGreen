# Vercel environment variables

Production values required for a fully functional deployment. Set these on the
`falsegreen` project for Production (and Preview if desired). Do not commit
secrets. See `docs/deployment.md` for behaviour and limits.

| Variable | Value |
| --- | --- |
| `EXECUTION_DRIVER` | `sandbox` |
| `STORE_DRIVER` | `redis` |
| `UPSTASH_REDIS_REST_URL` | Upstash HTTPS REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash REST token |
| `VERCEL_SANDBOX_SNAPSHOT_ID` | id printed by `scripts/build-sandbox-snapshot.mjs` |
| `MODEL_API_BASE_URL` | OpenAI-compatible endpoint |
| `MODEL_API_KEY` | provider key (server-side only) |
| `MODEL_ID` | model name |
| `JOB_DRIVER` | `vercel-workflow` |

`NODE_ENV` and `VERCEL` are supplied by the platform. Do not set
`FALSEGREEN_URL` in production.

The API routes are capped at 60 seconds in `vercel.json`, which works on the
Hobby plan. That is enough because the HTTP request only creates a run or asks
for a repair; scanning and verification execute as Workflow SDK steps. Keep
`JOB_DRIVER=vercel-workflow` in production so work does not depend on a single
60-second invocation.

## Sandbox snapshot

Run once per Node runtime and Vitest version, with Vercel credentials available
(`VERCEL_OIDC_TOKEN`, or `VERCEL_TOKEN` plus `VERCEL_TEAM_ID` and
`VERCEL_PROJECT_ID`):

```bash
node scripts/build-sandbox-snapshot.mjs
```

Use the printed snapshot id as `VERCEL_SANDBOX_SNAPSHOT_ID`.

## Publish

```bash
npx vercel@latest link --yes --project falsegreen
npx vercel@latest env add EXECUTION_DRIVER production   # repeat per variable
npx vercel@latest deploy --prod --yes
```

Then check `GET /api/config` returns 200 and the page HTML contains
"FalseGreen". A page load does not exercise Redis, the sandbox, the model, or
the workflow driver; run a real scan to verify those.
