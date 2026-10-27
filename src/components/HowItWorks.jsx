"use client";

export default function HowItWorks() {
  return (
    <details className="panel how">
      <summary>How this works</summary>
      <div className="how-body">
        <div>
          <h3>Pipeline</h3>
          <ol>
            <li>
              The submitted module is parsed and its comparison and logical operators are mutated,
              one token at a time.
            </li>
            <li>
              The submitted Vitest suite runs against the original and then against each mutant. A
              caught mutation means an existing test failed on that mutant. A missed mutation means
              every existing test still passed.
            </li>
            <li>
              For a missed mutation, the model proposes a test derived from the stated requirement.
              The proposal is validated, then rendered through a fixed template.
            </li>
            <li>
              The proposed test runs through four checks: original with existing tests, mutant with
              existing tests, original with existing and proposed tests, and mutant with existing and
              proposed tests. Only a failure on the proposed assertion counts.
            </li>
          </ol>
        </div>
        <div>
          <h3>Honest limits</h3>
          <ul>
            <li>
              A surviving mutation means the tests cannot distinguish the two versions. It is not
              proof of a bug, and a caught mutation is not proof of correctness.
            </li>
            <li>
              One implementation file and one test file per run. Named synchronous exports only;
              imports, default exports, async and generator functions are rejected.
            </li>
            <li>Vitest only. The test file must import <code>./source.js</code>.</li>
            <li>
              FalseGreen proposes a regression test. It does not edit the implementation or apply the
              patch for you.
            </li>
            <li>
              The stated requirement is the only source of intent. FalseGreen never infers intended
              behaviour from the implementation.
            </li>
            <li>
              One repair runs at a time per run. Model output is untrusted and is validated before
              anything executes.
            </li>
            <li>
              Each execution runs in a throwaway directory or sandbox. No visitor&apos;s code runs in
              another visitor&apos;s environment.
            </li>
          </ul>
        </div>
      </div>
    </details>
  );
}
