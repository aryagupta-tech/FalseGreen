# Deploying FalseGreen

This document covers a Vercel deployment with Upstash Redis and the Vercel
Sandbox execution driver. It is written against the code in this repository, not
against an intended architecture. Where a piece is declared but not wired, it is
called out.

## Current status

- Run state is persisted after every tick in Upstash Redis (production) or the
  file store (local and Docker).
- Two job drivers are wired:
  - `vercel-workflow` (default on Vercel): `src/workflows/scan.js` defines
    `runScanWorkflow` and `runRepairWorkflow`. Each engine tick is a durable
    Workflow SDK step, so a function restart resumes from the last persisted
    tick.
  - `inline` (default locally and in Docker): `driveRun()` loops inside the
    server process, scheduled with `after()` or a queued microtask.
  If a workflow cannot start, the route falls back to the inline driver.
- `JOB_DRIVER` selects the driver. The `workflow` package and the
  `withWorkflow()` Next config wrapper are installed and enabled.
- `assertProductionConfig()` exists in `src/core/config.js` but is not called by
  any route. Configuration gaps surface when a store or runner is constructed
  during a tick.
- `assertRunnerAvailable()` exists in `src/core/execution/index.js` but is not
  called by any route. A missing local Vitest install or snapshot id is
  discovered during a tick, not at submission time.
- `VERCEL_SANDBOX_RUNTIME` is read into config but is not used by the sandbox
  runner. The snapshot fixes the runtime. The provisioning script reads
  `FG_SANDBOX_RUNTIME` instead.
- A cancel request is a durable flag. The current execution is allowed to finish
  so its temp directory or sandbox is cleaned up; the next tick marks the run
  `cancelled` and releases the job slot.

## Vercel project setup

1. Import the repository as a Vercel project.
2. Use the Next.js framework preset. The app uses the App Router and
   `output: "standalone"` for self-hosting; Vercel builds it normally with
   `npm run build`.
3. Select Node 24. The repository does not pin `engines` in `package.json`, so
   set the runtime in project settings.
4. Add the environment variables in the table below. Vercel sets
   `NODE_ENV=production` for the runtime; the session cookie uses it to enable
   `secure`. Do not override it with a development value.
5. Set a function maximum duration that can cover `FG_SCAN_DEADLINE_MS` plus
   overhead, and a repair window of `FG_REPAIR_DEADLINE_MS` plus overhead. The
   repository has no `vercel.json` and sets no `maxDuration`. Work scheduled with
   `after()` still counts against the function lifetime.
6. Deploy. The first end-to-end check should be a real run, not only a page load.

There is no authentication. The `fg_session` cookie separates browser sessions
and controls run ownership, but it is not an access-control system. Use Vercel
Deployment Protection or another gate if the deployment should not be public.

## Upstash Redis

The Redis store uses the Upstash REST API through `@upstash/redis`. It does not
open a TCP connection.

1. Create a Redis database in Upstash.
2. Copy the REST URL and REST token.
3. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in the Vercel
   project.
4. Leave `STORE_DRIVER` unset to auto-select Redis when both values are present,
   or set `STORE_DRIVER=redis` explicitly. Explicit is safer in production.
5. Verify with a real scan. A page load does not exercise the store.

Behavior to know:

- If both Upstash values are present and `STORE_DRIVER` is unset, the Redis
  driver is selected automatically.
- If only one Upstash value is present and `STORE_DRIVER` is unset, the file
  store is selected. On Vercel the file store writes to `/tmp` and is local to an
  instance. Do not use that for production traffic.
- If `STORE_DRIVER=redis` and either value is missing, `RedisStore` throws
  `ConfigError` on first use.
- Leases use `SET NX PX`; release uses a compare-and-delete script; the rate
  window uses a Lua increment that preserves the original expiry. Upstash eval
  support is required for the atomic paths, with a best-effort fallback.
- Store keys: `fg:run:<id>`, `fg:lease:job:<slot>`, `fg:lock:run:<id>`, and
  `fg:rate:<sessionId>`. Run records do not contain secrets. The model key is
  never stored in a run record.

## Sandbox snapshot

The sandbox runner needs a snapshot with Node and Vitest installed at
`/opt/falsegreen`. Provision it once per runtime and Vitest version.

1. Authenticate one of these ways:
   - `VERCEL_OIDC_TOKEN` from the project, for example with
     `vercel env pull .env.local`.
   - `VERCEL_TOKEN` plus `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`.
2. Optionally set `FG_SANDBOX_RUNTIME` (`node24` by default) and
   `FG_VITEST_VERSION` (`5.0.5` by default).
3. From the repository root, run:

   ```bash
   node scripts/build-sandbox-snapshot.mjs
   ```

4. The script creates a sandbox with `networkPolicy: "allow-all"` for
   provisioning only, installs Vitest under `/opt/falsegreen`, runs a smoke
   suite, removes the smoke files, writes
   `/opt/falsegreen/falsegreen-snapshot.json`, snapshots with `expiration: 0`,
   and prints the snapshot id.
5. Add the printed value as `VERCEL_SANDBOX_SNAPSHOT_ID` in the Vercel project.
   The script also prints `VERCEL_SANDBOX_RUNTIME`; that variable is read into
   config but not used by the runner. The snapshot carries the runtime.
6. Set `EXECUTION_DRIVER=sandbox` explicitly. On Vercel it is the default when
   `VERCEL` is set, but explicit configuration is easier to audit.
7. Verify with a scan. A missing snapshot id produces a `ConfigError` when the
   runner is constructed during a tick, and the run fails.

At request time the sandbox is created from the snapshot with
`networkPolicy: "deny-all"` and `ports: []`, files are written under
`/tmp/falsegreen/run`, Vitest runs there, the JSON report is read, and
`sandbox.stop()` runs in `finally`. Model credentials and other secrets are not
written into the sandbox.

Rebuild the snapshot when you change the Node runtime or the Vitest version. The
runner expects the Vitest entrypoint at
`/opt/falsegreen/node_modules/vitest/vitest.mjs`.

## Production environment

| Variable | Required | Production value | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | platform | `production` | Set by Vercel. Enables the secure session cookie. |
| `VERCEL` | platform | set by Vercel | Changes driver defaults. Do not set locally. |
| `EXECUTION_DRIVER` | yes | `sandbox` | Use `local` only for a single trusted host. |
| `VERCEL_SANDBOX_SNAPSHOT_ID` | yes | printed snapshot id | Required by the sandbox runner. |
| `VERCEL_SANDBOX_RUNTIME` | no | `node24` | Read into config, not used by the runner. The snapshot fixes the runtime. |
| `STORE_DRIVER` | yes | `redis` | Explicit is safer than auto-detection. |
| `UPSTASH_REDIS_REST_URL` | yes | HTTPS REST URL | No TCP URL. |
| `UPSTASH_REDIS_REST_TOKEN` | yes | REST token | Server-side secret. |
| `FG_DATA_DIR` | no | unused | Only for the file store. Vercel `/tmp` is not durable. |
| `MODEL_DRIVER` | no | `auto` or `openai-compatible` | Repair only. |
| `MODEL_API_BASE_URL` | for repair | endpoint URL | With or without a trailing `/v1`. |
| `MODEL_API_KEY` | for repair | provider key | Never sent to the browser or sandbox. |
| `MODEL_ID` | for repair | model name | Shown in the UI as configured. |
| `MODEL_TIMEOUT_MS` | no | `45000` | Per-request model timeout. |
| `MODEL_MAX_TOKENS` | no | `900` | Proposal output cap. |
| `JOB_DRIVER` | no | `vercel-workflow` | On Vercel this is the default. `inline` is available as a fallback. |
| `FG_MAX_MUTATIONS` | no | `12` | Per-run mutation cap. |
| `FG_MAX_ACTIVE_JOBS` | no | `2` | Global scan and repair slots. |
| `FG_MAX_MODEL_ATTEMPTS` | no | `2` | Model attempts per repair. |
| `FG_TEST_TIMEOUT_MS` | no | `10000` | Per-execution timeout. |
| `FG_SCAN_DEADLINE_MS` | no | `180000` | Scan deadline. |
| `FG_REPAIR_DEADLINE_MS` | no | `120000` | Repair deadline. |
| `FG_RUN_TTL_MS` | no | `86400000` | 24-hour run record lifetime. |
| `FG_MAX_RUNS_PER_SESSION_PER_HOUR` | no | `20` | Per-session rate limit. |
| `FG_KEEP_LOCAL_ARTIFACTS` | no | `0` | Keep local temp dirs only for debugging. |

Do not set `FALSEGREEN_URL` in production. It is a CLI-only variable.

## Quotas and limits

The defaults are defined in `src/core/config.js`. Only the variables in the table
above are environment-configurable.

| Limit | Default | Effect |
| --- | --- | --- |
| `maxSourceBytes` | 65536 | Submitted module size. Fixed. |
| `maxTestsBytes` | 65536 | Submitted test size. Fixed. |
| `maxRequirementBytes` | 4096 | Requirement size. Fixed. |
| `maxMutations` | 12 | Mutations collected per run. |
| `maxActiveJobs` | 2 | Global leases shared by scans and repairs. |
| `maxModelAttempts` | 2 | Proposal attempts per repair. |
| `testTimeoutMs` | 10000 | Vitest and process timeout per execution. |
| `scanDeadlineMs` | 180000 | After this, remaining mutations become `untested`. |
| `repairDeadlineMs` | 120000 | Repair window, including verification. |
| `runTtlMs` | 86400000 | Run record TTL, 24 hours. |
| `maxRunsPerSessionPerHour` | 20 | Run creation limit per session. |
| `maxArgsBytes` | 4096 | Proposed args size. Fixed. |
| `maxOutputBytes` | 65536 | Captured stdout and stderr. Fixed. |
| `pollIntervalMs` | 700 | UI polling interval. Fixed. |

The API body limit is 256 KiB. The UI shows `1 of 2 tested mutations caught`
style counts, not a quality score.

## TTL and cleanup

- A run record expires `FG_RUN_TTL_MS` after creation. Writes pass a remaining
  TTL to the store. Redis uses `PX`; the file store writes `__expiresAt` and
  enforces it on read.
- The file store does not run a background sweeper. Expired files are removed
  when read.
- Job slot leases live for the scan or repair deadline plus 30 seconds. The
  repair-request lock lives for 15 seconds. Scan and repair ticks hold the run
  lock for the remaining deadline plus 30 seconds, with a 15-second minimum.
- The rate window is one hour and expires with the key.
- Local runner temp directories are removed in `finally` unless
  `FG_KEEP_LOCAL_ARTIFACTS=1`.
- Sandboxes are stopped in `finally`. They are not reused.
- Expired runs return `404` and cannot be repaired or downloaded.

## Concurrency and leases

- `maxActiveJobs` controls global slots named `fg:lease:job:0` through
  `fg:lease:job:<maxActiveJobs-1>`. Scans and repairs share the same slots.
- A slot is acquired with an atomic lease. Redis uses `SET NX PX`; the file store
  uses an exclusive lock file opened with `wx` and reclaims stale leases.
- A run has a lock named `fg:lock:run:<id>`. `withLock` retries for up to 500 ms
  and then returns `409` with `This run is busy. Try again.`
- A run allows one repair at a time. A new request replaces a finished repair;
  it is rejected while a repair is queued or running.
- If no slot is free, a scan stays queued and the inline driver retries. There is
  no queue depth metric or backpressure beyond the session rate limit.
- The session rate limit is enforced at `POST /api/runs` with a one-hour window.
  It does not limit polling, repair requests, or artifact downloads.

## Durability

Each tick is one durable unit:

1. Read the run from the store.
2. Take the run lock.
3. Perform the next bounded step: baseline, one mutant, or one repair pass with
   up to `maxModelAttempts` model calls, the render, and the four-run matrix.
4. Persist the run with a remaining TTL.
5. Release the lock and return.

State is only in the store; module scope holds no per-run state. A repeated tick
is safe: it reads the persisted phase and does the next unit only.

With `JOB_DRIVER=vercel-workflow`, the Workflow SDK invokes one step per tick:

```
start(runScanWorkflow, [runId])
  -> tickScan -> persist
  -> tickScan -> persist
  -> ... until completed, failed, or cancelled
```

A step that finishes is not repeated after a restart. A step that fails is
retried by the SDK and then persisted as a run failure. Repair uses
`runRepairWorkflow` with the same pattern.

The inline driver (`JOB_DRIVER=inline`) loops in the process. It is reliable for
local development and Docker, but a process restart leaves an unfinished run in
`queued`, `running`, or `repairing` until its TTL expires. A later `GET` does not
resume it, and a repair request is rejected until the scan completes. Use the
workflow driver when automatic resumption matters.

Workflow runs appear in `npx workflow inspect runs` and in the local observability
UI (`npx workflow web`).

## Health check

There is no `/api/health` route.

- Process readiness: `GET /api/config` returns `200` with public config and
  presets. It proves the Next process is serving and `loadConfig()` succeeds. It
  does not check Upstash, the sandbox, or the model. The bundled Dockerfile uses
  this endpoint as its container healthcheck.

  ```bash
  curl -fsS https://your-deployment.example/api/config >/dev/null
  ```

- Configuration check: inspect the JSON for `executionDriver`,
  `modelConfigured`, and `modelId`. No secrets are returned.
- End-to-end check: create a run with a tiny module and poll it to completion.
  This exercises the store and the execution driver. Use the same `fg_session`
  cookie jar for creation and polling.

  ```bash
  curl -fsS -c cookies.txt \
    -H 'content-type: application/json' \
    -d '{"requirement":"add returns the sum","source":"export function add(a, b) { return a + b; }","tests":"import { expect, test } from \"vitest\";\nimport { add } from \"./source.js\";\ntest(\"adds\", () => { expect(add(2, 3)).toBe(5); });"}' \
    https://your-deployment.example/api/runs
  ```

- Repository tests: `npm test` covers the mutation engine, validation, execution
  normalization, store, job flow, model validation, and verification.

## Operations checklist

- [ ] Node 24 selected for the Vercel project.
- [ ] The runtime reports `NODE_ENV=production`, so the session cookie is secure.
- [ ] `EXECUTION_DRIVER=sandbox` is set explicitly.
- [ ] `VERCEL_SANDBOX_SNAPSHOT_ID` is set and belongs to the current runtime.
- [ ] The snapshot was rebuilt after the last Vitest or Node change.
- [ ] `STORE_DRIVER=redis` and both Upstash REST values are set.
- [ ] A real scan succeeds and a run record is visible in Redis.
- [ ] `MODEL_API_BASE_URL`, `MODEL_API_KEY`, and `MODEL_ID` are set if repairs
      are enabled. If not, the UI must report the model as unconfigured.
- [ ] The model endpoint answers within `MODEL_TIMEOUT_MS`.
- [ ] `FG_SCAN_DEADLINE_MS` and `FG_REPAIR_DEADLINE_MS` fit the function
      duration limit.
- [ ] `FG_MAX_ACTIVE_JOBS` matches the expected concurrency and the function
      concurrency.
- [ ] The session rate limit is appropriate for the expected traffic.
- [ ] A verified repair downloads all three artifacts and the patch applies with
      `git apply`.
- [ ] A requirement mismatch produces no downloads.
- [ ] Expired runs return `404`.
- [ ] Logs are monitored for `[falsegreen]` driver and API errors.
- [ ] Deployment protection is enabled if the app is not meant to be public.
- [ ] No secret is present in client config, artifacts, or sandbox files.
- [ ] The file store is not used for production traffic on Vercel.
- [ ] The durability gap is accepted or a durable worker has been wired.
