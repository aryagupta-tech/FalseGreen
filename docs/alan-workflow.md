# Alan workflow

This is a concrete session script for using Alan with FalseGreen. Alan writes and
reviews the product and drives the verification loop. The configured open model
proposes a candidate regression test. Execution decides what is verified. The
model never writes the executable test; its proposal is validated data rendered
through a fixed template.

## How the pieces are used

- **Alan** reads the requirement, runs the CLI, reads the run record, and decides
  which missed mutation to repair. Alan must not infer intended behaviour from the
  implementation.
- **The open model** receives the requirement, source, existing tests, missed
  mutation, and execution evidence. It returns one JSON proposal:
  `title`, `exportName`, `args`, `expected`, `rationale`. It does not return
  code. The model is configured with `MODEL_API_BASE_URL`, `MODEL_API_KEY`, and
  `MODEL_ID`.
- **Execution** runs the four-cell matrix. Only a matrix where the original and
  mutant pass the existing tests, the original passes the proposed test, and the
  mutant fails on the proposed assertion is a verified repair.
- Alan may explain a mismatch, but Alan cannot promote an unverified proposal.
  The matrix is the acceptance test.

## Before you start

Start the app in one terminal:

```bash
cd /absolute/path/to/FalseGreen
npm install
npm link
export MODEL_API_BASE_URL=https://your-model-endpoint.example/v1
export MODEL_API_KEY=replace-with-a-real-key
export MODEL_ID=your-model-id
npm run dev
```

`npm link` installs the `falsegreen` command from `bin/falsegreen.js`. If you do
not want a global link, invoke `node /absolute/path/to/FalseGreen/bin/falsegreen.js`
instead.

Scanning works without the model. `falsegreen check` needs the model once it
reaches a repair. If the model is not configured, the repair endpoint returns
`503 not_configured` and the CLI exits with code 1.

In a second terminal, create a scratch repository for the generated fixture:

```bash
mkdir -p /tmp/falsegreen-alan
cd /tmp/falsegreen-alan
git init -q
npm init -y >/dev/null
npm pkg set type=module

FG_PROJECT=/absolute/path/to/FalseGreen
ln -s "$FG_PROJECT/node_modules" node_modules
```

Keep the generated requirement, source, and tests in this directory. The symlink
lets the generated test import `vitest` without a second install. The patch adds a
file, so a git repository makes `git apply` straightforward.

## Step 1: ask Alan for the fixture

Give Alan this exact prompt. It fixes the requirement before the implementation
and deliberately omits the boundary from the tests.

> Generate a FalseGreen fixture about a shipping fee. The requirement is: orders
> of ₹1,000 or more ship free; orders below ₹1,000 pay ₹99. Write `source.js` as
> one self-contained ES module exporting one named synchronous function
> `shippingFee(orderTotal)`. Write `source.test.js` as a passing Vitest suite
> that imports `shippingFee` from `./source.js` and tests 500 and 1500 only. Do
> not test 1000. No imports other than `vitest` and `./source.js`, no mocks, no
> TypeScript, no async, no default export. Output the requirement, `source.js`,
> and `source.test.js` in separate fenced blocks.

Save the three blocks as `requirement.txt`, `source.js`, and `source.test.js`.
Check that the tests pass before running FalseGreen:

```bash
FG_PROJECT=/absolute/path/to/FalseGreen
node "$FG_PROJECT/node_modules/vitest/vitest.mjs" run source.test.js
```

The expected result is two passing tests against the original implementation.

## Step 2: scan for missed mutations

Run the CLI in scan mode first. It does not need a model.

```bash
falsegreen scan \
  --source source.js \
  --tests source.test.js \
  --requirement @requirement.txt \
  --url http://localhost:3000 \
  --json > scan.json
```

`--json` writes the final run record to stdout and sends progress to stderr, so
`scan.json` stays clean. The scan exits with code `2` when it finds a missed
mutation. That is the expected result for this fixture, not a transport failure.

If the CLI is not linked, use the direct entrypoint:

```bash
node /absolute/path/to/FalseGreen/bin/falsegreen.js scan \
  --source source.js \
  --tests source.test.js \
  --requirement @requirement.txt \
  --json > scan.json
```

## Step 3: inspect missed mutations

Give Alan the scan record and this exact prompt:

> Here is the FalseGreen run JSON. List every mutation with its status. For each
> missed mutation, state the exact input and behaviour the existing tests cannot
> distinguish. Treat it as a test gap only if a requirement-derived test would
> pass on the original implementation. If that test would fail on the original,
> call it a requirement mismatch and quote the conflicting requirement clause. Do
> not infer intent from `source.js`.

A compact local summary:

```bash
node -e '
  const body = JSON.parse(require("fs").readFileSync("scan.json", "utf8"));
  const run = body.run ?? body;
  console.log("status", run.status, "stop", run.scan?.stopReason);
  for (const m of run.mutations ?? []) {
    console.log(m.id, m.status, m.change, m.counts ?? "");
  }
  console.log("scan", JSON.stringify(run.scan));
'
```

Expected shape for the shipping fixture:

- `m1` boundary, `>=` becomes `>`, status `missed`.
- `m2` comparison, `>=` becomes `<`, status `caught`.
- `run.scan.missed` is 1 and `run.scan.caught` is 1.

The missed `m1` is the boundary at exactly ₹1,000. The existing tests only use
500 and 1500. Because the requirement includes ₹1,000 and the source uses `>=`,
this is a test gap, not a requirement mismatch.

## Step 4: request a verified repair

Run `check` for the missed mutation. This scans again, requests one repair, runs
the verification matrix, and saves the artifacts if verified.

```bash
falsegreen check \
  --source source.js \
  --tests source.test.js \
  --requirement @requirement.txt \
  --url http://localhost:3000 \
  --mutation m1 \
  --out artifacts \
  --json > run.json
```

The CLI exits with code `0` for a verified repair and code `2` for a requirement
mismatch or any other non-verified result. A mismatch writes no artifacts. The
CLI saves `falsegreen.generated.test.js`, `falsegreen.patch`, and
`falsegreen.evidence.json` in `artifacts/` only when the repair is verified. It
does not apply the patch unless you add `--apply`; inspect it first below.

At this point give Alan this exact prompt:

> Accept the repair only if `run.repair.status` is `verified` and all four matrix
> rows have `status: "pass"`. The final row must fail on the proposed assertion,
> not on a compile error or timeout. If the result is `mismatch`, stop and explain
> the conflicting requirement; do not edit `source.js` and do not apply a patch.
> If the result is `rejected`, `error`, or `timeout`, report that no verified
> repair was produced.

## Step 5: inspect the matrix and apply the patch

```bash
node -e '
  const body = JSON.parse(require("fs").readFileSync("run.json", "utf8"));
  const repair = (body.run ?? body).repair;
  console.log(JSON.stringify({
    status: repair?.status,
    proposal: repair?.proposal,
    matrix: repair?.verification?.matrix,
    mismatch: repair?.verification?.mismatch
  }, null, 2));
'
```

For the shipping fixture the expected matrix is:

| Row | Expected | Observed |
| --- | --- | --- |
| Original plus existing tests | pass | 2 passed |
| Mutant plus existing tests | pass | 2 passed |
| Original plus proposed test | pass | 3 passed |
| Mutant plus proposed test | fail on the proposed assertion | 2 passed, 1 failed, `expected 99 to be 0` |

The generated test is:

```js
import { expect, test } from "vitest";
import { shippingFee } from "./source.js";

test("gives free shipping at exactly 1000", () => {
  expect(shippingFee(1000)).toBe(0);
});
```

Ask Alan to verify the patch before applying it:

> Read `artifacts/falsegreen.patch`. Confirm it is an additive diff that creates
> `source.regression.test.js` and does not change `source.js`. If it touches
> `source.js`, stop and report the patch as invalid.

Then apply it:

```bash
git apply artifacts/falsegreen.patch
```

If you prefer one command, `falsegreen check ... --apply --yes` applies the patch
directly after verification and skips the confirmation prompt.

## Step 6: re-run Vitest

The scratch directory now contains `source.test.js` and
`source.regression.test.js`. Run both explicitly so Vitest does not also pick up
the generated copy in `artifacts/`:

```bash
node "$FG_PROJECT/node_modules/vitest/vitest.mjs" run source.test.js source.regression.test.js
```

Expected result: three passing tests. The original suite still passes, and the
new boundary test passes.

If you want to demonstrate that the regression test has teeth, apply the boundary
mutant by hand in a copy and run the suite again. With `>=` changed to `>`, the
new test should fail with `expected 99 to be 0`, while the two original tests
still pass. Do not commit that mutant.

## Prompt for the final review

> Summarize the run as: baseline result, each mutation and status, the missed
> behaviour, the proposal, the four matrix rows, and the final verdict. State
> whether the repair is verified or a requirement mismatch. Do not claim a source
> fix, a quality score, or proof of correctness. The patch adds one regression
> test only.

## What not to do

- Do not ask the model to write test code directly. The proposal is JSON and the
  template is fixed.
- Do not treat a missed mutation as proof of a bug. It means the tests cannot
  distinguish two versions.
- Do not accept a timeout or execution error as caught.
- Do not apply a patch from a `mismatch`, `rejected`, `error`, or `timeout`
  repair.
- Do not edit the implementation to make the proposed test pass. A mismatch is a
  requirement conflict, not a test to rewrite.
