"use client";

import { useMemo } from "react";
import StatusBadge from "./StatusBadge";
import DiffView from "./DiffView";
import { formatDuration } from "./format";

const GROUPS = [
  {
    status: "missed",
    title: "Missed",
    blurb: "Every existing test still passed. The suite cannot tell these versions apart.",
  },
  {
    status: "caught",
    title: "Caught",
    blurb: "An existing test failed on the mutant, so the suite distinguishes it.",
  },
  {
    status: "timeout",
    title: "Timed out",
    blurb: "The suite did not finish. A timeout is never counted as caught.",
  },
  {
    status: "error",
    title: "Execution errors",
    blurb: "The suite could not run against the mutant. Never counted as caught.",
  },
  {
    status: "untested",
    title: "Untested",
    blurb: "Not executed. Untested is not evidence either way.",
  },
];

const KNOWN_STATUSES = new Set(GROUPS.map((group) => group.status));

const FAMILY_LABEL = {
  boundary: "Boundary comparison",
  comparison: "Comparison direction",
  equality: "Equality check",
  logical: "Logical operator",
};

function normalizeStatus(status) {
  return KNOWN_STATUSES.has(status) ? status : "untested";
}

function familyExplanation(mutation) {
  const operator = mutation.operator ?? "the operator";
  const replacement = mutation.replacement ?? "its alternative";

  switch (mutation.family) {
    case "boundary":
      return `The threshold comparison changed from ${operator} to ${replacement}. No existing test separates the inclusive and exclusive versions of the boundary, so the edge is not pinned down.`;
    case "comparison":
      return `The comparison changed from ${operator} to ${replacement}, which reverses the direction. No existing test distinguishes the two directions, so this comparison is unverified.`;
    case "equality":
      return `The equality check changed from ${operator} to ${replacement}. No existing test distinguishes equality from inequality here.`;
    case "logical":
      return `The boolean operator changed from ${operator} to ${replacement}. No existing test distinguishes the two operators here.`;
    default:
      return `The operator changed from ${operator} to ${replacement}. No existing test distinguishes the original from the mutant.`;
  }
}

function statusExplanation(mutation) {
  const status = normalizeStatus(mutation.status);
  const operator = mutation.operator ?? "the operator";
  const replacement = mutation.replacement ?? "its alternative";

  if (status === "missed") {
    return `The tests pass against both versions. ${familyExplanation(mutation)} A surviving mutation means the suite cannot distinguish the versions; it is not proof of a bug.`;
  }
  if (status === "caught") {
    return `At least one existing test failed against the mutant, so the suite distinguishes the change from ${operator} to ${replacement}.`;
  }
  if (status === "timeout") {
    return `The suite did not finish within the execution limit against the mutant, so no comparison was made. The change from ${operator} to ${replacement} is unverified. A timeout is not counted as caught.`;
  }
  if (status === "error") {
    return `The suite could not execute against the mutant, so no comparison was made. The change from ${operator} to ${replacement} is unverified. An execution error is not counted as caught.`;
  }
  return `This mutant was never executed, so there is no comparison. The change from ${operator} to ${replacement} is unverified, and untested is not evidence either way.`;
}

function repairLabel(run, mutationId) {
  const repair = run?.repair;
  if (!repair || repair.mutationId !== mutationId) return null;
  return repair;
}

export default function MutationList({
  run,
  selectedMutationId,
  onSelect,
  onRequestRepair,
  repairPendingMutationId = null,
  modelConfigured = false,
}) {
  const mutations = Array.isArray(run?.mutations) ? run.mutations : [];
  const grouped = useMemo(() => {
    const buckets = new Map(GROUPS.map((group) => [group.status, []]));
    for (const mutation of mutations) {
      buckets.get(normalizeStatus(mutation?.status)).push(mutation);
    }
    return GROUPS.map((group) => ({ ...group, items: buckets.get(group.status) })).filter(
      (group) => group.items.length > 0,
    );
  }, [mutations]);

  const selected = mutations.find((mutation) => mutation?.id === selectedMutationId) ?? null;
  const repair = run?.repair ?? null;
  const repairBusy = repair?.status === "queued" || repair?.status === "running";
  const pendingRequest = repairPendingMutationId !== null;
  const runComplete = run?.status === "completed";

  function canPropose(mutation) {
    if (!mutation || normalizeStatus(mutation.status) !== "missed") return false;
    if (!modelConfigured || !runComplete || repairBusy || pendingRequest) return false;
    const existing = repairLabel(run, mutation.id);
    if (existing?.status === "verified") return false;
    return true;
  }

  function proposeTitle(mutation) {
    if (!modelConfigured) {
      return "Repair is disabled until MODEL_API_BASE_URL, MODEL_API_KEY and MODEL_ID are set.";
    }
    if (repairBusy || pendingRequest) return "A repair is already in progress.";
    if (!runComplete) return "Repair is available after the scan completes.";
    if (repairLabel(run, mutation?.id)?.status === "verified") {
      return "This mutation already has a verified repair.";
    }
    return "Propose a regression test and run the four-step verification matrix.";
  }

  const stop = run?.scan?.stopReason;
  let emptyMessage = null;
  if (!run) {
    emptyMessage = "No run yet. Start a check to generate mutations from the implementation.";
  } else if (mutations.length === 0) {
    if (run.failure) {
      emptyMessage = "The run failed before mutations were generated.";
    } else if (stop === "baseline_failed" || stop === "no_tests") {
      emptyMessage = "No mutations were run because the baseline did not pass.";
    } else if (stop === "no_mutations") {
      emptyMessage = "No mutable comparison or logical operators were found in this source.";
    } else if (run.status === "completed") {
      emptyMessage = "No mutations were generated for this source.";
    } else {
      emptyMessage = "Mutations appear once the baseline passes.";
    }
  }

  return (
    <section className="panel mutations" aria-labelledby="mutations-heading">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Scan</p>
          <h2 id="mutations-heading">Mutations</h2>
        </div>
        <span className="panel-meta">
          {mutations.length > 0 ? `${mutations.length} generated` : run ? "None yet" : "Waiting"}
        </span>
      </div>

      {emptyMessage ? <p className="empty-note">{emptyMessage}</p> : null}

      {grouped.map((group) => (
        <div className="mutation-group" key={group.status}>
          <h3 className="group-head">
            <StatusBadge status={group.status} />
            <span className="group-count">{group.items.length}</span>
          </h3>
          <p className="group-blurb">{group.blurb}</p>
          <ul className="mutation-list">
            {group.items.map((mutation) => {
              const status = normalizeStatus(mutation.status);
              const isSelected = mutation.id === selectedMutationId;
              const existing = repairLabel(run, mutation.id);
              const showPropose = status === "missed";
              const disabled = !canPropose(mutation);

              return (
                <li
                  className="mutation-row"
                  data-selected={isSelected ? "true" : "false"}
                  key={mutation.id ?? `${status}-${mutation.line}`}
                >
                  <button
                    type="button"
                    className="mutation-select"
                    aria-expanded={isSelected}
                    aria-controls={isSelected ? "mutation-detail" : undefined}
                    onClick={() => onSelect?.(mutation.id)}
                  >
                    <span className="mutation-op">
                      {mutation.operator ?? "?"} <span aria-hidden="true">→</span>{" "}
                      {mutation.replacement ?? "?"}
                    </span>
                    <span className="mutation-change">
                      {mutation.change || FAMILY_LABEL[mutation.family] || "Operator changed"}
                    </span>
                    <StatusBadge status={status} />
                    <span className="mutation-meta">
                      {typeof mutation.line === "number" ? <span>line {mutation.line}</span> : null}
                      {typeof mutation.durationMs === "number" ? (
                        <span>{formatDuration(mutation.durationMs)}</span>
                      ) : null}
                    </span>
                  </button>

                  {showPropose ? (
                    existing?.status === "verified" ? (
                      <span className="row-verified">
                        <StatusBadge status="verified" />
                      </span>
                    ) : repairBusy && existing ? (
                      <span className="row-verified">
                        <StatusBadge status={repair.status} />
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--small btn--ghost mutation-action"
                        onClick={() => onRequestRepair?.(mutation.id)}
                        disabled={disabled}
                        title={proposeTitle(mutation)}
                        aria-label={`Propose and verify a test for mutation ${mutation.id ?? "this mutation"}`}
                      >
                        {repairPendingMutationId === mutation.id
                          ? "Requesting…"
                          : "Propose and verify a test"}
                      </button>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {selected ? (
        <div
          className="mutation-detail"
          id="mutation-detail"
          role="region"
          aria-label={`Details for mutation ${selected.id ?? "selected mutation"}`}
        >
          <div className="detail-head">
            <div>
              <p className="eyebrow">
                Mutation {selected.id ?? "—"}
                {typeof selected.line === "number" ? ` · line ${selected.line}` : ""}
                {typeof selected.column === "number" ? `:${selected.column}` : ""}
              </p>
              <h3 className="detail-title">
                {FAMILY_LABEL[selected.family] ?? "Operator change"}
              </h3>
            </div>
            <StatusBadge status={normalizeStatus(selected.status)} />
          </div>

          <p className="detail-explanation">{statusExplanation(selected)}</p>

          {selected.reason ? (
            <p className="detail-note">
              <span className="detail-key">Run note</span> {selected.reason}
            </p>
          ) : null}

          {selected.counts ? (
            <p className="detail-note">
              <span className="detail-key">Suite result</span>{" "}
              {selected.counts.total ?? 0} tests · {selected.counts.passed ?? 0} passed ·{" "}
              {selected.counts.failed ?? 0} failed
              {typeof selected.counts.skipped === "number" && selected.counts.skipped > 0
                ? ` · ${selected.counts.skipped} skipped`
                : ""}
            </p>
          ) : null}

          {typeof selected.before === "string" && typeof selected.after === "string" ? (
            <DiffView
              before={selected.before}
              after={selected.after}
              path={run?.input?.sourceName ?? "source.js"}
            />
          ) : (
            <p className="detail-note">The exact diff for this mutation is not available.</p>
          )}

          {normalizeStatus(selected.status) === "missed" ? (
            <div className="detail-actions">
              {repairLabel(run, selected.id)?.status === "verified" ? (
                <span className="detail-note">
                  This mutation has a verified repair. See the repair panel for the test and
                  downloads.
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => onRequestRepair?.(selected.id)}
                    disabled={!canPropose(selected)}
                    title={proposeTitle(selected)}
                  >
                    {repairPendingMutationId === selected.id
                      ? "Requesting…"
                      : "Propose and verify a test"}
                  </button>
                  {!modelConfigured ? (
                    <span className="detail-note">
                      Set MODEL_API_BASE_URL, MODEL_API_KEY and MODEL_ID on the server to enable
                      repairs.
                    </span>
                  ) : repairBusy ? (
                    <span className="detail-note">A repair is already in progress.</span>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : mutations.length > 0 ? (
        <p className="empty-note">Select a mutation to see the exact diff and what it changes.</p>
      ) : null}
    </section>
  );
}
