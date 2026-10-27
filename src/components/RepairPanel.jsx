"use client";

import StatusBadge from "./StatusBadge";
import { formatDuration, formatInlineJson, humanizeStatus, truncate } from "./format";

const FALLBACK_MAX_ATTEMPTS = 2;

function expectedLabel(value) {
  if (value === "pass") return "Pass";
  if (value === "fail-proposed") return "Fail on proposed assertion";
  if (!value) return "—";
  return humanizeStatus(value);
}

function observedLabel(value) {
  if (!value) return "—";
  return humanizeStatus(value);
}

function resultValue(value) {
  if (value === undefined || value === null) return "—";
  if (typeof value === "string") return value;
  return formatInlineJson(value);
}

export default function RepairPanel({
  run,
  mutation,
  onRequest,
  requestPendingId = null,
  error = null,
  model = {},
}) {
  const repair = run?.repair ?? null;
  const repairMutation =
    (Array.isArray(run?.mutations) ? run.mutations : []).find(
      (item) => item?.id === repair?.mutationId,
    ) ?? null;
  const status = repair?.status ?? null;
  const busy = status === "queued" || status === "running";
  const verification = repair?.verification ?? null;
  const attempts = Array.isArray(repair?.attempts) ? repair.attempts : [];
  const proposal = repair?.proposal ?? null;
  const mismatch = verification?.mismatch ?? null;
  const configured = Boolean(model?.modelConfigured);
  const modelId = typeof model?.modelId === "string" ? model.modelId : null;
  const configuredMaxAttempts = model?.limits?.maxModelAttempts;
  const maxAttempts =
    typeof configuredMaxAttempts === "number" &&
    Number.isFinite(configuredMaxAttempts) &&
    configuredMaxAttempts > 0
      ? Math.floor(configuredMaxAttempts)
      : FALLBACK_MAX_ATTEMPTS;

  const selectedMissed = mutation?.status === "missed";
  const selectedRepair = repair && mutation && repair.mutationId === mutation.id ? repair : null;
  const selectedVerified = selectedRepair?.status === "verified";
  const requestPending = requestPendingId !== null;
  const canRequest =
    Boolean(run) &&
    run.status === "completed" &&
    selectedMissed &&
    configured &&
    !busy &&
    !requestPending &&
    !selectedVerified;

  const isVerified = status === "verified";
  const terminalFailure =
    status === "rejected" || status === "error" || status === "timeout";

  const showRequest = !repair || (Boolean(mutation) && selectedMissed && !selectedVerified);

  let disabledReason = null;
  if (!configured) {
    disabledReason = null;
  } else if (requestPending) {
    disabledReason = "Request sent. Waiting for the run to update.";
  } else if (busy) {
    disabledReason =
      selectedRepair?.mutationId === repair?.mutationId
        ? "A repair for this mutation is running."
        : `A repair for mutation ${repair?.mutationId ?? "another mutation"} is already running.`;
  } else if (!run) {
    disabledReason = "Start a check first.";
  } else if (run.status !== "completed") {
    disabledReason = "Repair is available after the scan completes.";
  } else if (!mutation) {
    disabledReason = "Select a missed mutation in the list.";
  } else if (!selectedMissed) {
    disabledReason = "Only missed mutations can be repaired.";
  }

  const requestLabel = requestPending
    ? "Requesting…"
    : selectedRepair && !selectedVerified
      ? "Propose another test"
      : "Propose and verify a test";

  const attemptProgress = busy
    ? proposal && !verification
      ? "Proposal accepted. Executing the four-step verification matrix."
      : `Attempt ${Math.min(maxAttempts, attempts.length + 1)} of up to ${maxAttempts}. Waiting for the model.`
    : null;

  return (
    <section className="panel repair" aria-labelledby="repair-heading">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Repair</p>
          <h2 id="repair-heading">Proposed regression test</h2>
        </div>
        {repair ? (
          <StatusBadge
            status={status ?? "queued"}
            label={status === "error" ? "Repair failed" : status === "timeout" ? "Repair timed out" : undefined}
          />
        ) : null}
      </div>

      <div className="model-row">
        <span className="model-label">Model</span>
        <span className="mono model-id">{configured ? modelId || "configured" : "not configured"}</span>
        <StatusBadge
          status={configured ? "done" : "untested"}
          label={configured ? "Configured" : "Not configured"}
          tone={configured ? "muted" : "amber"}
        />
        {repair && typeof repair.durationMs === "number" ? (
          <span className="model-duration">{formatDuration(repair.durationMs)}</span>
        ) : null}
      </div>

      {!configured ? (
        <p className="notice notice--amber" id="repair-config-note">
          Repair is disabled because no model is configured. Set{" "}
          <code>MODEL_API_BASE_URL</code>, <code>MODEL_API_KEY</code> and <code>MODEL_ID</code> in
          the server environment, then restart. <code>MODEL_DRIVER</code> defaults to{" "}
          <code>auto</code>. Scanning and mutation results do not need a model.
        </p>
      ) : null}

      {error ? (
        <div
          className={`alert ${error.code === "conflict" ? "alert--amber" : "alert--red"}`}
          role="alert"
        >
          <div className="alert-head">
            <StatusBadge
              status={error.code === "not_configured" ? "untested" : "failed"}
              label={error.code === "not_configured" ? "Not configured" : "Repair request failed"}
            />
            {error.status ? <span className="code-chip">HTTP {error.status}</span> : null}
          </div>
          <p>{error.message || "The repair request could not be started."}</p>
          {error.code ? <span className="code-chip">{error.code}</span> : null}
        </div>
      ) : null}

      {showRequest ? (
        <div className="request-block">
          <div className="request-target">
            <p className="eyebrow">Request</p>
            {mutation ? (
              <p>
                <span className="mono">{mutation.id ?? "selected mutation"}</span>
                {mutation.change ? <span className="request-change"> · {mutation.change}</span> : null}
              </p>
            ) : (
              <p>No missed mutation selected.</p>
            )}
          </div>
          <div className="request-actions">
            <button
              type="button"
              className="btn btn--small"
              onClick={() => onRequest?.(mutation?.id)}
              disabled={!canRequest}
              aria-describedby={
                !configured
                  ? "repair-config-note"
                  : disabledReason
                    ? "repair-request-note"
                    : undefined
              }
            >
              {requestLabel}
            </button>
            {disabledReason ? (
              <p className="request-note" id="repair-request-note">
                {disabledReason}
              </p>
            ) : null}
            {repair && !selectedVerified && !busy && !requestPending ? (
              <p className="request-note">
                {repair.status === "verified"
                  ? "The verified repair and its downloads will be replaced."
                  : "A new request replaces the current repair."}
              </p>
            ) : null}
          </div>
        </div>
      ) : repair ? (
        <p className="request-note">
          Select a different missed mutation to propose another test. Only one repair runs at a
          time.
        </p>
      ) : null}

      {repair ? (
        <div className="repair-detail">
          <div className="repair-target">
            <p className="eyebrow">Target</p>
            <p>
              <span className="mono">{repair.mutationId ?? "—"}</span>
              {repairMutation?.change ? (
                <span className="request-change"> · {repairMutation.change}</span>
              ) : null}
            </p>
          </div>

          {attemptProgress ? (
            <p className="repair-live" role="status" aria-live="polite">
              {attemptProgress}
            </p>
          ) : null}

          <div className="attempts-block">
            <p className="subhead">Attempts</p>
            {attempts.length > 0 ? (
              <ol className="attempts">
                {attempts.map((attempt, index) => (
                  <li className="attempt" key={attempt?.index ?? index}>
                    <span className="attempt-index">
                      #{typeof attempt?.index === "number" ? attempt.index + 1 : index + 1}
                    </span>
                    <span className="attempt-body">
                      {attempt?.proposal?.title ? (
                        <>
                          Proposal: <span className="mono">{attempt.proposal.title}</span>
                        </>
                      ) : attempt?.error ? (
                        <>Rejected: {attempt.error}</>
                      ) : (
                        <>No result recorded.</>
                      )}
                    </span>
                    <span className="attempt-time">{formatDuration(attempt?.durationMs)}</span>
                  </li>
                ))}
              </ol>
            ) : busy ? (
              <p className="attempts-empty">Attempt 1 in progress.</p>
            ) : (
              <p className="attempts-empty">No model attempt was recorded.</p>
            )}
          </div>

          {proposal ? (
            <section className="proposal" aria-labelledby="proposal-heading">
              <h3 id="proposal-heading">{proposal.title}</h3>
              <dl className="kv">
                <div className="kv-row">
                  <dt>Export</dt>
                  <dd className="mono">{proposal.exportName}</dd>
                </div>
                <div className="kv-row">
                  <dt>Arguments</dt>
                  <dd>
                    <code className="inline-code">{formatInlineJson(proposal.args)}</code>
                  </dd>
                </div>
                <div className="kv-row">
                  <dt>Expected</dt>
                  <dd>
                    <code className="inline-code">{formatInlineJson(proposal.expected)}</code>
                  </dd>
                </div>
                <div className="kv-row">
                  <dt>Rationale</dt>
                  <dd>{proposal.rationale}</dd>
                </div>
              </dl>
            </section>
          ) : null}

          {repair.generatedTest ? (
            <section className="generated" aria-labelledby="generated-heading">
              <div className="subhead-row">
                <h3 id="generated-heading">Generated test</h3>
                <span className="mono file-chip">
                  {repair.generatedTestFile || "source.regression.test.js"}
                </span>
              </div>
              <pre className="code-block">
                <code>{repair.generatedTest}</code>
              </pre>
            </section>
          ) : null}

          {verification?.matrix?.length ? (
            <section className="matrix-section" aria-labelledby="matrix-heading">
              <div className="subhead-row">
                <h3 id="matrix-heading">Verification matrix</h3>
                <span className="mono file-chip">{verification.matrix.length} runs</span>
              </div>
              <div className="matrix-wrap">
                <table className="matrix">
                  <caption className="sr-only">
                    Four-step verification: original and mutant code with existing and proposed
                    tests.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Check</th>
                      <th scope="col">Expected</th>
                      <th scope="col">Observed</th>
                      <th scope="col">Status</th>
                      <th scope="col">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {verification.matrix.map((row, index) => (
                      <tr key={row?.id ?? index}>
                        <th scope="row">
                          {row?.label || row?.id || `Check ${index + 1}`}
                          {row?.id ? <span className="matrix-id">{row.id}</span> : null}
                          {row?.detail ? (
                            <span className="matrix-detail" title={row.detail}>
                              {truncate(String(row.detail).split("\n")[0], 220)}
                            </span>
                          ) : null}
                        </th>
                        <td>{expectedLabel(row?.expected)}</td>
                        <td>{observedLabel(row?.observed)}</td>
                        <td>
                          <StatusBadge
                            status={row?.status === "pass" ? "pass" : "fail"}
                            label={row?.status === "pass" ? "Matched" : "Unexpected"}
                          />
                        </td>
                        <td className="matrix-time">{formatDuration(row?.durationMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {isVerified ? (
            <div className="verdict verdict--green" role="status" aria-live="polite">
              <div className="verdict-head">
                <StatusBadge status="verified" />
                <h3>Verified repair</h3>
              </div>
              <p>
                The existing suite passes on the original and on the mutant. The proposed test
                passes on the original, and the combined suite fails on the mutant at the proposed
                assertion.
              </p>
            </div>
          ) : status === "mismatch" || verification?.status === "mismatch" ? (
            <div className="verdict verdict--amber" role="status" aria-live="polite">
              <div className="verdict-head">
                <StatusBadge status="mismatch" />
                <h3>Requirement mismatch</h3>
              </div>
              <p>
                The proposed requirement-derived test fails against the original implementation. The
                stated requirement and the code disagree, so no repair is offered.
              </p>
              <dl className="mismatch">
                <div className="kv-row">
                  <dt>Requirement</dt>
                  <dd>{mismatch?.requirement || run?.input?.requirement || "—"}</dd>
                </div>
                <div className="kv-row">
                  <dt>Input</dt>
                  <dd>
                    <code className="inline-code">{resultValue(mismatch?.args)}</code>
                  </dd>
                </div>
                <div className="kv-row">
                  <dt>Expected</dt>
                  <dd>
                    <code className="inline-code">{resultValue(mismatch?.expected)}</code>
                  </dd>
                </div>
                <div className="kv-row">
                  <dt>Observed</dt>
                  <dd>
                    <code className="inline-code">{resultValue(mismatch?.observed)}</code>
                  </dd>
                </div>
              </dl>
              {mismatch?.message ? <p className="verdict-note">{mismatch.message}</p> : null}
              <p className="verdict-note">
                Revise the requirement or implementation and start a new check. A new proposal in
                this run would use the same requirement.
              </p>
            </div>
          ) : terminalFailure ? (
            <div className={`verdict verdict--${status === "error" ? "red" : "muted"}`}>
              <div className="verdict-head">
                <StatusBadge
                  status={status}
                  label={status === "timeout" ? "Repair timed out" : "No verified repair"}
                  tone={status === "error" ? "red" : "muted"}
                />
                <h3>No verified repair</h3>
              </div>
              <p>
                {repair.failure ||
                  verification?.detail ||
                  (status === "rejected"
                    ? "The proposed test did not fail the mutant on its own new assertion, so it was rejected."
                    : status === "timeout"
                      ? "The repair exceeded its deadline before verification finished."
                      : "The repair stopped before producing a verified test.")}
              </p>
              <p className="verdict-note">
                Nothing is offered for download. You can retry a proposal, or start a new check with
                revised inputs.
              </p>
            </div>
          ) : busy ? (
            <p className="repair-live" role="status" aria-live="polite">
              {proposal
                ? "Verification is running. Four executions decide whether the test counts."
                : "The model is drafting a test from the requirement and the missed mutation."}
            </p>
          ) : null}

          {status === "queued" ? (
            <p className="request-note">Queued for a repair worker.</p>
          ) : null}
        </div>
      ) : (
        <p className="empty-note">
          No repair requested. Select a missed mutation and propose a test to see the model proposal,
          generated test and verification matrix.
        </p>
      )}

      {verification?.detail && !terminalFailure && !isVerified && verification.status !== "mismatch" ? (
        <p className="request-note">{verification.detail}</p>
      ) : null}

      {repair && typeof repair.startedAt === "number" && typeof repair.finishedAt === "number" ? (
        <p className="repair-foot">
          Repair window {formatDuration(Math.max(0, repair.finishedAt - repair.startedAt))}
        </p>
      ) : null}
    </section>
  );
}
