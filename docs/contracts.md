# Engine contract

This is the module-level contract for the framework-free engine. It is useful
when adding a driver, changing a run-record field, or embedding the engine in
another surface. Every module is ESM JavaScript with JSDoc types. Node 20.9+,
Next 16 App Router, React 19, Vitest 5.

## Shared constants

```js
// src/core/config.js
loadConfig(env?) -> { limits, execution, store, model, jobDriver, publicConfig }
loadLimits(env?) -> limits
DEFAULT_LIMITS // frozen defaults
```

`limits` fields: `maxSourceBytes, maxTestsBytes, maxRequirementBytes, maxMutations,
maxActiveJobs, maxModelAttempts, testTimeoutMs, scanDeadlineMs, repairDeadlineMs,
runTtlMs, maxRunsPerSessionPerHour, maxArgsBytes, maxOutputBytes, pollIntervalMs`.

```js
// src/core/errors.js
AppError(code, message, status, details?), ValidationError(message, details?),
NotFoundError(message?), ConflictError(message, details?),
RateLimitError(message?), ConfigError(message), errorBody(error) -> { status, body }
```

```js
// src/core/diff.js
diffLines(before, after) -> Array<{ type:'context'|'remove'|'add', line:number, text:string }>
compactHunks(rows, context=1) -> rows
unifiedDiffForNewFile(path, content, opts?) -> string  // git apply compatible
```

## 1. Input validation — `src/core/validate-input.js`

```js
validateInput({ requirement, source, tests }, limits)
  -> { ok: true, exports: [{ name, kind:'function'|'arrow' }], mutationsAvailable: number }
  |  { ok: false, errors: [{ field:'requirement'|'source'|'tests', code, message }] }
```

Rules (all must be enforced, with specific messages):

- UTF-8 byte limits: source 64 KiB, tests 64 KiB, requirement 4 KiB. Empty
  requirement is invalid.
- Source must parse as an ES module. A parse error returns `field:'source'`,
  `code:'source_parse_error'` and a message with line/column.
- Source must contain at least one named exported synchronous function
  (`export function f(){}`, `export const f = () => {}`, `export const f =
  function () {}`). `code:'no_exported_function'`. Reject async/generator
  exported functions (`code:'unsupported_export'`). If a source has a default
  export, reject with `code:'unsupported_export'`.
- Source must be self-contained: reject `ImportDeclaration`, `require(...)`,
  `import(...)` with `code:'unsupported_import'` and the module specifier.
- Test file must parse; reject imports other than `vitest` and `./source.js`
  (`code:'unsupported_import'`). Reject `vi.mock`/`vi.hoisted` with
  `code:'unsupported_mock'`. Reject `require(`, dynamic import, `import.meta`
  usage with `code:'unsupported_syntax'`.
- Test file must reference the source import (a test that never imports
  `./source.js` is rejected: `code:'tests_do_not_import_source'`).
- Test file must contain at least one `test(...)`/`it(...)` call, else
  `code:'no_tests'`.
- Source/test file names are fixed: `source.js`, `source.test.js`.
- `mirror` mutation-relevant checks must be cheap (single parse each).

Also export `parseModule(code, { allowReturnOutsideFunction = false })` used by
the mutation engine, returning the Babel `File` node and throwing
`ValidationError` with `source_parse_error` details.

## 2. Mutation engine — `src/core/mutations.js`

```js
collectMutations(source, limits) -> Arrow[]   // deterministic, max limits.maxMutations
// Arrow = {
//   id: 'm1', family: 'boundary'|'comparison'|'equality'|'logical',
//   operator: '>=', replacement: '>',
//   start: number, end: number,        // exact operator source range
//   line: number, column: number,      // 1-based
//   before: string, after: string,     // full source before/after
//   change: string                     // human text: ">= 1000 becomes > 1000"
// }
applyMutation(source, mutation) -> string
MUTATION_FAMILIES // { boundary: {...}, ... } for docs/UI labels
```

Families and pairs:

- boundary: `>=`→`>`, `>`→`>=`, `<=`→`<`, `<`→`<=`
- comparison: `>=`→`<`, `<`→`>=`, `>`→`<=`, `<=`→`>`
- equality: `===`→`!==`, `!==`→`===`
- logical: `&&`→`||`, `||`→`&&`

Walk `BinaryExpression` and `LogicalExpression`. Only the operator token range is
replaced, never the operands, and never comments outside the token. If the
operator token cannot be located in `node.left.end..node.right.start`, skip that
mutation. Sort by `start`, then family order `boundary, comparison, equality,
logical`, then declaration order. Slice to `maxMutations` after sorting. Throw
`ValidationError('no_mutations', ...)` is NOT the engine's job: an empty array is
returned and the job layer decides.

The exact boundary demo: `orderTotal >= 1000` yields `m1` boundary `>=`→`>` and
`m2` comparison `>=`→`<`.

## 3. Execution — `src/core/execution/`

Directory exports a factory:

```js
// src/core/execution/index.js
createRunner(config) -> Runner
assertRunnerAvailable(config) -> Promise<void>   // throws ConfigError
```

```js
// Runner
runTests({
  files: { 'source.js': string, 'source.test.js': string },
  timeoutMs: number,
  signal?: AbortSignal
}) -> Promise<ExecutionResult>
```

```js
// ExecutionResult
{
  outcome: 'completed' | 'timeout' | 'error',
  counts: { total: number, passed: number, failed: number, skipped: number },
  tests: [{ name: string, status: 'passed'|'failed'|'skipped', failureMessages: string[] }],
  durationMs: number,
  exitCode: number | null,
  error: string | null,           // infra/compile error, human readable
  logs: { stdout: string, stderr: string }  // truncated to limits.maxOutputBytes
}
```

`outcome:'error'` covers compile/import/infrastructure failures. A test assertion
failure is `outcome:'completed'` with `counts.failed > 0`. Never classify a
nonzero exit alone as caught.

`src/core/execution/vitest-results.js`:

```js
normalizeVitestJson(json, { durationMs, exitCode, stdout, stderr }) -> ExecutionResult
parseVitestFailure(message) -> { kind:'assertion'|'error', actual?: unknown, expected?: unknown } | null
```
Vitest 5 JSON shape: `{ numTotalTests, numPassedTests, numFailedTests,
numPendingTests, testResults: [{ assertionResults: [{ title, fullName, status,
failureMessages }] }] }`. Accept both `failureMessages` arrays and
`failureMessage` strings. Assertion messages look like
`AssertionError: expected 99 to be 0` (also `expected 99 to deeply equal 0`).

Local runner (`local-runner.js`): per invocation `fs.mkdtemp` under
`os.tmpdir()/falsegreen-*`, write the two files, a `package.json` with
`{"type":"module"}`, and `vitest.config.mjs` (`environment:'node'`, `pool:'forks'`,
`include:['source.test.js']`, `testTimeout` = timeoutMs). Symlink the project
`node_modules` into the temp dir so `vitest` resolves. Spawn
`process.execPath <root>/node_modules/vitest/vitest.mjs run --config
vitest.config.mjs --reporter=json --outputFile=results.json --no-color` with a
minimal env (`PATH`, `HOME=tmp`, `TMPDIR=tmp`, `NODE_ENV=test`, `CI=1`), cwd=tmp.
Kill on timeout (`SIGKILL`, status `timeout`). Always remove the temp dir in
`finally` unless `FG_KEEP_LOCAL_ARTIFACTS=1`. Never pass `process.env` through.

Sandbox runner (`sandbox-runner.js`): `@vercel/sandbox` `Sandbox.create({
source:{type:'snapshot', snapshotId}, networkPolicy:'deny-all', ports: [], timeout
})`, write files under `/tmp/falsegreen/run`, run
`node /opt/falsegreen/node_modules/vitest/vitest.mjs run ...` with `cwd` and
`timeoutMs`, read `/tmp/falsegreen/run/results.json` through the filesystem API,
then `sandbox.stop()` in `finally`. Credentials come from the platform. Never
write `MODEL_API_KEY` or any secret into the sandbox. Missing snapshot id →
`ConfigError`.

`scripts/build-sandbox-snapshot.mjs`: build the pinned snapshot. Creates a
sandbox from `node24`, installs `vitest@5.0.5` into `/opt/falsegreen` (network
allowed for this provisioning step only), writes a marker, snapshots it, prints
the snapshot id. This is a provisioning script, not used at request time.

## 4. Model adapter — `src/core/model/`

```js
createModel(config) -> { proposeTest({ requirement, source, tests, mutation, execution, previousAttempt }) -> Promise<Proposal>, describe() -> { driver, id } }
```
Driver `openai-compatible`: POST `${baseUrl}/chat/completions` (baseUrl may end in
`/v1`) with `model: MODEL_ID`, `temperature: 0`, JSON-only instructions,
`response_format:{type:'json_object'}` when supported, `AbortSignal.timeout`.
Extract JSON from content (tolerate a fenced block), validate with
`validateProposal(raw, { exports })`.

```js
// proposal schema, exactly this shape
{ title: string (3..120), exportName: string (must be exported),
  args: JSON array (<= 8 items), expected: JSON value, rationale: string (<= 500) }
```
Reject extra keys, mocks, code strings, functions. `expected` must be
JSON-serializable and args <= 4096 bytes. Throw `ProposalError` with a specific
message (exported `errors.js` for the module is fine) so the job layer can retry
once with feedback.

`renderProposal(input, proposal) -> { fileName, content, testName }`:
deterministic template, no model text in executable positions; use
`toBe` for primitives/null and `toEqual` for objects/arrays.

```js
import { expect, test } from "vitest";
import { shippingFee } from "./source.js";

test("gives free shipping at exactly 1000", () => {
  expect(shippingFee(1000)).toBe(0);
});
```
Test titles are sanitized (strip backticks, `${`, newlines, quotes). `exportName`
must match `/^[A-Za-z_$][\w$]*$/`. `args` are JSON-stringified with 2 spaces
inline when multi-arg. Deterministic: same proposal → same file.

Model drivers: `openai-compatible` and `unconfigured` (throws `ConfigError` with
"Set MODEL_API_BASE_URL, MODEL_API_KEY and MODEL_ID"). Also accept
`MODEL_DRIVER=ollama` as an alias for openai-compatible with baseUrl default
`http://127.0.0.1:11434/v1`.

## 5. Verification — `src/core/verify.js`

Pure functions only.

```js
verifyRepair({ proposal, generatedTest, run: runTests, source, tests, mutation })
  -> Promise<{ status:'verified'|'mismatch'|'rejected'|'error',
               matrix: MatrixRow[], mismatch: Mismatch|null, detail: string|null }>
// MatrixRow = { id:'original-existing'|'mutant-existing'|'original-proposed'|'mutant-proposed',
//               label, expected:'pass'|'fail-proposed', observed:'pass'|'fail'|'timeout'|'error',
//               status:'pass'|'fail', durationMs, detail }
```
Execution rules: mutant file = applyMutation(source, mutation). Proposed run files
= existing tests + `source.regression.test.js`. The proposed run must fail
*because of the generated assertion*: `tests` must contain the generated test
name with `status:'failed'` and an assertion failure; a compile error or timeout
does not count. `mismatch` is set when `original-proposed` fails on the generated
assertion: `{ requirement, args, expected, observed, message }` where `observed`
comes from the assertion message, else `'different value'`. The requirement text
is passed in by the caller for the mismatch record.

## 6. Store — `src/core/store/`

```js
// src/core/store/index.js
createStore(config) -> Store
```
```js
// Store (all async)
get(key) -> object|null
set(key, value, { ttlMs }?) -> void
delete(key) -> void
acquireLease(name, ttlMs) -> token|null          // atomic SET NX PX
releaseLease(name, token) -> void                // compare-and-delete
incrementWindow(key, windowMs) -> number         // atomic counter with expiry
withLock(name, ttlMs, fn) -> result              // retry for <=500ms, then ConflictError
```
Drivers: `redis` (`@upstash/redis`, REST) and `file` (JSON files under
`config.store.fileDir`, atomic rename, lock files opened with `wx`, stale lease
reclaim). File TTL enforced on read (`__expiresAt`). Never store secrets in run
records.

Keys: `fg:run:<id>`, lease `fg:lease:job:<slot>`, lock `fg:lock:run:<id>`,
rate `fg:rate:<sessionId>`.

Jobs acquire one of `maxActiveJobs` global job slots named
`fg:lease:job:${i}` with TTL = deadline + 30s.

## 7. Job engine — `src/core/jobs/`

```js
// engine.js
createRun({ store, limits, sessionId, input }) -> Promise<Run>   // validation + persistence
enqueueScan({ store, config, run }) -> Promise<void>             // mark queued
tickScan({ store, config, runId }) -> Promise<Run>               // ONE durable unit of work
requestRepair({ store, limits, runId, mutationId }) -> Promise<Run>
tickRepair({ store, config, runId }) -> Promise<Run>
```
```js
// driver.js
driveRun({ store, config, runId, waitUntil? }) -> Promise<void>  // loop tickScan/tickRepair until done
```
`waitUntil` is the `@vercel/functions` hook if present; otherwise fire-and-forget
in-process loop. Every tick is idempotent: it reads the run, performs at most one
step, persists, and returns. State is only ever in the store.

Run record:

```js
{
  id: 'run_<12 base32>',
  sessionId,
  createdAt, updatedAt, expiresAt,          // epoch ms
  status: 'queued'|'running'|'repairing'|'completed'|'failed',
  phase: 'queued'|'baseline'|'mutations'|'proposal'|'verification'|'done',
  deadlineAt,
  input: { requirement, source, tests, sourceName:'source.js', testName:'source.test.js' },
  exports: [{name, kind}],
  baseline: null | ExecutionResult,
  mutations: [ { ...mutation, status:'untested'|'caught'|'missed'|'timeout'|'error',
                 durationMs:number|null, counts:{...}|null, reason:string|null } ],
  scan: null | { tested, caught, missed, errors, timeouts, untested, durationMs, stopReason },
  selectedMutationId: null,
  repairRequestedFor: null,
  repair: null | RepairRecord,
  steps: [ { at, key, status:'running'|'done'|'failed', ms, detail } ],
  failure: null | { code, message }
}
```
`RepairRecord`: `{ mutationId, status:'queued'|'running'|'verified'|'mismatch'|'rejected'|'error'|'timeout',
attempts:[{ index, proposal:Proposal|null, error:string|null, durationMs }],
proposal:Proposal|null, generatedTest:string|null,
verification:{status, matrix, mismatch, detail}|null,
artifacts:{ 'falsegreen.generated.test.js':string, 'falsegreen.patch':string,
            'falsegreen.evidence.json':string }|null,
failure:string|null, durationMs, startedAt, finishedAt }`

Scan flow: baseline → if baseline not `completed` or `counts.total===0` or
`counts.failed>0`, stop with `stopReason` (`baseline_failed`, `no_tests`), phase
`done`, status `completed` (not an error: the result is a clear message). Then
each mutant once. If `Date.now() > deadlineAt`, remaining mutations become
`untested` and `stopReason='deadline'`. `status='completed'` when the scan
finishes, even if every mutation is missed; only infrastructure failure sets
`failed`.

Repair flow: acquire run lock, verify the mutation is `missed` and owned; set
status `repairing`, phase `proposal`. Tick 1: call model (max 2 attempts, second
attempt includes the first validation error and matrix feedback if any). Tick 2:
render test, run the 4-step matrix (can be one tick), persist artifacts on
verified. Each run allows one repair at a time; a new repair replaces the old one.

`tickScan` must handle a run created by another process; never keep per-run
state in module scope except an idempotency guard that is safe to lose.

## 8. API — `src/app/api/`

- `POST /api/runs` `{ requirement, source, tests }` → 201 `{ runId, run }`.
  Sets/reads the `fg_session` cookie. 400 `{ error:{code,message,details} }`.
- `GET /api/runs/:id` → 200 `{ run }`. Never another session's run (404).
- `POST /api/runs/:id/repairs` `{ mutationId }` → 202 `{ run }`; 409 when the
  mutation is not missed, a repair is already running, or the run is not
  complete. 503 `{ error.code:'not_configured' }` when no model is configured.
- `GET /api/runs/:id/artifacts/:name` → download. Accept
  `falsegreen.generated.test.js`, `falsegreen.patch`,
  `falsegreen.evidence.json` and the short aliases `test`, `patch`, `evidence`.
  403 until the repair is verified. Content types: `text/javascript`,
  `text/x-patch`, `application/json`. `Content-Disposition: attachment`.
- `GET /api/config` → `{ config: publicConfig, presets }` (no secrets).
- Every route: `export const dynamic = 'force-dynamic'`, `export const runtime =
  'nodejs'`.
- Add `Cache-Control: no-store` to all API responses.
- Body limit 256 KiB, JSON only. Translate `AppError` via `errorBody`.
- Start the driver with `after()` from `next/server` when available (Next 16), or
  schedule `driveRun(...)` without awaiting.

`src/lib/session.js`: `getSessionId()` (reads/creates the cookie, 30 days,
httpOnly, sameSite lax, secure in production), `requireSameSession(run, sessionId)`.

`src/lib/http.js`: `json(data, status)`, `readJsonBody(request, maxBytes)`,
`handleApi(fn)`.

Rate limit: `store.incrementWindow('fg:rate:'+sessionId, 1h)` and reject above
`maxRunsPerSessionPerHour` with `RateLimitError`.

## 9. UI — `src/app/page.js`, `src/components/*`, `src/app/globals.css`

Server page renders `<Playground initialPreset={...} presets={...} publicConfig={...} />`
as a client component. `GET /api/config` is available, but initial props avoid a
flash.

Requirements:

- Opens on the playground with the checkout preset loaded. No marketing page, no
  login. A compact header states the promise.
- Expected-behavior field, two CodeMirror editors (JS), preset switcher, "Check
  my tests" button, reset.
- Progress: baseline → mutations → proposal → verification, each with status,
  duration, and a live summary. Polls `GET /api/runs/:id` every 700ms while
  active. Stop polling on terminal status.
- Baseline failure and zero-test outcomes are explicit panels, never a broken
  spinner.
- Mutation list: operator chip, status (caught/missed/timeout/error/untested)
  with text + icon, duration. Selecting a mutation shows an exact code diff (line
  numbers, -/+ rows) and a plain-language explanation of the behaviour the tests
  missed. Missed mutations offer "Propose and verify a test".
- Repair panel: model attempt count, proposal (title, args, expected, rationale),
  generated test preview, verification matrix as 4 rows with expected/observed,
  and either Verified / Requirement mismatch / No verified repair. Mismatch shows
  requirement, input, expected, observed.
- Verified downloads only after verification: generated test, patch, evidence
  JSON. Buttons are disabled with a reason before that.
- Show model identity and whether it is configured. When unconfigured, the repair
  button explains what env vars are missing. Do not fake a model.
- Show `1 of 2 tested mutations caught` style counts, never a "quality score".
- Include a short "How this works" disclosure and an honest limitations line.
- Accessible: labels, focus rings, `aria-live` for status, color never the only
  signal, reduced-motion respected.
- Visual direction: precise instrument panel, near-black canvas (#0b0d0c), warm
  off-white text, one green accent (#5ee38a) used only for verified/caught
  states, amber for mismatch, red for failure, blue-grey for neutral. Mono for
  code, sans for prose. 12–14px dense UI, generous 24px section padding, thin
  1px borders, no gradients, no glassmorphism, no emoji.
- Responsive: two columns ≥1100px, stacked below.
- CodeMirror: `@uiw/react-codemirror`, `javascript()`, dark theme, line numbers,
  no autocompletion popups, height ~220px, `basicSetup` minimal.

## 10. CLI — `bin/falsegreen.js`

Node shebang, no deps. Usage:
`falsegreen check --source <path> --tests <path> --requirement <text|@file> [--url] [--apply] [--json] [--out dir]`.
Uses `FALSEGREEN_URL` (default `http://localhost:3000`) and a cookie jar file in
`~/.falsegreen/session`. Submits, polls, prints a concise report, saves
`falsegreen.generated.test.js`, `falsegreen.patch`, `falsegreen.evidence.json` in
`--out`. `--apply` runs `git apply <patch>` after confirmation. `--json` prints
the final run record. Exit codes: 0 verified/scan complete, 2 verification not
produced, 1 usage/transport error. `--help` documents everything. Also
`falsegreen scan` alias for check without repair.

## 11. Docs / infra

`README.md` (setup, env table, architecture, limits, honest limitations, demo
script, CLI, Alan workflow), `LICENSE` (MIT, 2026), `.env.example`,
`Dockerfile` (Next standalone, Node 24 slim, non-root, includes vitest runtime),
`.dockerignore`, `docker-compose.yml` with optional Redis? No: Upstash is REST;
compose runs the app only with file store and local runner. `docs/alan-workflow.md`,
`docs/deployment.md` (Vercel, Upstash, sandbox snapshot, Workflows).

The Docker image must run `npm run build` in a builder stage and serve
`.next/standalone/server.js`. The local execution driver needs the project's
`node_modules/vitest`, so copy the traced standalone output **and**
`node_modules` (or at least vitest + its deps) into the runtime stage. Verify
with `docker build` if Docker is available.
