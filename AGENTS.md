# FalseGreen — engineering notes for agents

FalseGreen finds the mistakes passing tests let through: it mutates a submitted
ES module, runs the submitted Vitest suite against each mutant, and only offers a
repair after the proposed regression test is executed through a verification
matrix.

## Ground rules

- JavaScript only (ESM). No TypeScript, no new runtime dependencies without a
  clear need.
- The mutation engine, execution adapters, model adapter, store, and report
  generation must stay framework-free under `src/core/`. Next.js route handlers
  are thin adapters.
- Never trust model output. It is data, validated and rendered through a
  deterministic template.
- Never infer the intended behaviour from the implementation. The stated
  requirement is the only source of intent.
- A surviving mutation means "the tests cannot tell these versions apart". It is
  not proof of a bug.
- Every execution happens in a throwaway directory or sandbox. No visitor's code
  is ever executed in another visitor's environment.
- Keep user-visible copy direct and specific. No exclamation marks, no emoji.

## Layout

```
src/core/          engine (no Next.js imports)
src/app/api/       route handlers
src/components/    client UI
src/lib/           session, presets, http helpers
bin/               CLI
tests/             repo tests (Vitest)
scripts/           demo + sandbox snapshot builder
```

## Verification vocabulary

- Caught: an existing test detects the mutant.
- Missed: all existing tests still pass against the mutant.
- Timed out / Execution error / Untested: never counted as caught.
- Verified repair: original+existing pass, mutant+existing pass,
  original+existing+proposed pass, mutant+existing+proposed fails on the
  proposed assertion.
- Requirement mismatch: the proposed requirement-derived test fails against the
  original implementation.

## Commands

- `npm test`
- `npm run demo`
- `npm run build`
- `npm run dev`
