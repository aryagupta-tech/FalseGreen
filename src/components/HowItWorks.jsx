"use client";

export default function HowItWorks() {
  return (
    <details className="panel how" id="how">
      <summary>How this works</summary>
      <div className="how-body">
        <div>
          <h3>What it does</h3>
          <ol>
            <li>Changes one comparison or logical operator in your module at a time.</li>
            <li>
              Runs your Vitest suite against each version. Caught means a test failed; missed means
              every test still passed.
            </li>
            <li>
              For a missed change, the open model proposes a requirement-derived test. It is offered
              only after four executions verify it.
            </li>
          </ol>
        </div>
        <div>
          <h3>What it does not do</h3>
          <p>
            A missed mutation means the tests cannot distinguish two versions. It is not proof of a
            bug. FalseGreen does not edit your source or prove the rest of the module correct.
          </p>
        </div>
      </div>
    </details>
  );
}
