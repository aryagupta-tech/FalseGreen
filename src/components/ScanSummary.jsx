"use client";

import StatusBadge from "./StatusBadge";
import { mutationCounts } from "./RunProgress";
import { formatCount, formatDuration, truncate } from "./format";

function failureMessages(baseline) {
  const tests = Array.isArray(baseline?.tests) ? baseline.tests : [];
  return tests
    .filter((test) => test?.status === "failed")
    .slice(0, 3)
    .map((test) => {
      const messages = Array.isArray(test.failureMessages)
        ? test.failureMessages
        : typeof test.failureMessages === "string"
          ? [test.failureMessages]
          : typeof test.failureMessage === "string"
            ? [test.failureMessage]
            : [];
      return {
        name: test.name ?? test.fullName ?? "Unnamed test",
        message: messages[0] ? truncate(messages[0], 320) : null,
      };
    });
}

export default function ScanSummary({ run }) {
  if (!run) return null;

  const counts = mutationCounts(run);
  const baseline = run.baseline;
  const scan = run.scan;
  const stop = scan?.stopReason;
  const baselineCounts = baseline?.counts ?? {};
  const totalTests = typeof baselineCounts.total === "number" ? baselineCounts.total : null;
  const passedTests = typeof baselineCounts.passed === "number" ? baselineCounts.passed : null;
  const failedTests = typeof baselineCounts.failed === "number" ? baselineCounts.failed : null;
  const failures = failureMessages(baseline);

  let primary = null;

  if (run.failure) {
    primary = (
      <div className="alert alert--red">
        <div className="alert-head">
          <StatusBadge status="failed" label="Run failed" />
        </div>
        <p>
          {run.failure.message || "The run stopped before producing a result."}
          {run.failure.code ? <span className="code-chip">{run.failure.code}</span> : null}
        </p>
        <p className="alert-note">
          This is an infrastructure failure, not a verdict on the submitted tests.
        </p>
      </div>
    );
  } else if (baseline && baseline.outcome === "timeout") {
    primary = (
      <div className="alert alert--amber">
        <div className="alert-head">
          <StatusBadge status="timeout" label="Baseline timed out" />
        </div>
        <p>
          The submitted suite did not finish within the execution limit, so nothing was mutated. Timed
          out is not treated as caught.
        </p>
      </div>
    );
  } else if (baseline && baseline.outcome === "error") {
    primary = (
      <div className="alert alert--red">
        <div className="alert-head">
          <StatusBadge status="failed" label="Baseline could not run" />
        </div>
        <p>{baseline.error || "The submitted suite failed to compile or import."}</p>
        <p className="alert-note">Nothing was mutated because the baseline did not complete.</p>
      </div>
    );
  } else if (totalTests === 0 || stop === "no_tests") {
    primary = (
      <div className="alert alert--amber">
        <div className="alert-head">
          <StatusBadge status="untested" label="No tests ran" tone="amber" icon="alert" />
        </div>
        <p>
          The test file executed zero tests. Add at least one <code>test(...)</code> or{" "}
          <code>it(...)</code> call, then check again.
        </p>
        <p className="alert-note">
          FalseGreen does not mutate a module when there is no test to tell any two versions apart.
        </p>
      </div>
    );
  } else if (baseline && failedTests !== null && failedTests > 0) {
    primary = (
      <div className="alert alert--red">
        <div className="alert-head">
          <StatusBadge status="failed" label="Baseline failed" />
        </div>
        <p>
          The submitted suite does not pass against the submitted code
          {totalTests !== null ? `: ${passedTests ?? 0} of ${totalTests} tests passed` : ""}. A failing
          suite cannot distinguish versions, so nothing was mutated.
        </p>
        {failures.length > 0 ? (
          <ul className="failure-list">
            {failures.map((failure) => (
              <li key={failure.name}>
                <span className="failure-name">{failure.name}</span>
                {failure.message ? <code className="failure-message">{failure.message}</code> : null}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="alert-note">Fix the baseline first. The scan has not judged your tests yet.</p>
      </div>
    );
  }

  let stopPanel = null;
  if (stop === "cancelled") {
    stopPanel = (
      <div className="alert alert--muted">
        <div className="alert-head">
          <StatusBadge status="cancelled" />
        </div>
        <p>
          The run was stopped before it finished. Anything already collected is shown, but nothing is
          treated as verified unless the four-step matrix completed.
        </p>
      </div>
    );
  } else if (stop === "deadline") {
    stopPanel = (
      <div className="alert alert--amber">
        <div className="alert-head">
          <StatusBadge status="timeout" label="Scan stopped at the deadline" />
        </div>
        <p>
          {formatCount(counts.untested, "mutation")} {counts.untested === 1 ? "was" : "were"} not tested.
          Untested is never counted as caught and is not evidence either way.
        </p>
      </div>
    );
  } else if (stop === "no_mutations") {
    stopPanel = (
      <div className="alert alert--muted">
        <div className="alert-head">
          <StatusBadge status="untested" label="No mutable operators" />
        </div>
        <p>
          FalseGreen changes only <code>&gt;=</code>, <code>&gt;</code>, <code>&lt;=</code>,{" "}
          <code>&lt;</code>, <code>===</code>, <code>!==</code>, <code>&amp;&amp;</code> and{" "}
          <code>||</code> in expressions. This source has none in a position that can be changed
          safely.
        </p>
      </div>
    );
  } else if (
    stop &&
    !["complete", "baseline_failed", "no_tests", "deadline", "no_mutations"].includes(stop)
  ) {
    stopPanel = (
      <div className="alert alert--muted">
        <div className="alert-head">
          <StatusBadge status="untested" label="Scan stopped early" />
        </div>
        <p>
          Stop reason: <code>{stop}</code>.
        </p>
      </div>
    );
  }

  const showSummary = Boolean(scan) && counts.tested > 0 && !run.failure;

  if (!primary && !stopPanel && !showSummary) return null;

  return (
    <div className="scan-summary">
      {primary}
      {stopPanel}

      {showSummary ? (
        <section className="panel summary-panel" aria-labelledby="summary-heading">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Scan</p>
              <h2 id="summary-heading">What the suite can tell apart</h2>
            </div>
            {typeof counts.durationMs === "number" ? (
              <span className="panel-meta">{formatDuration(counts.durationMs)}</span>
            ) : null}
          </div>

          <p className="summary-metric">
            <strong>{counts.caught}</strong>
            <span>of</span>
            <strong>{counts.tested}</strong>
            <span>tested mutations caught</span>
          </p>

          <div className="summary-chips">
            <span className="stat">
              <span className="stat-value">{counts.missed}</span> missed
            </span>
            <span className="stat">
              <span className="stat-value">{counts.timeouts}</span> timed out
            </span>
            <span className="stat">
              <span className="stat-value">{counts.errors}</span> execution errors
            </span>
            <span className="stat">
              <span className="stat-value">{counts.untested}</span> untested
            </span>
          </div>

          <p className="summary-note">
            Caught means an existing test failed on that mutant. Missed means every existing test still
            passed. Timed out, execution error and untested are never counted as caught.
          </p>

          {baseline && totalTests !== null ? (
            <div className="summary-foot">
              <span>
                Baseline: {passedTests ?? 0} of {totalTests} passed
                {failedTests ? `, ${failedTests} failed` : ""}
              </span>
              {typeof baseline.durationMs === "number" ? (
                <span>{formatDuration(baseline.durationMs)}</span>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
