"use client";

import { useEffect, useState } from "react";
import StatusBadge from "./StatusBadge";
import { formatDuration } from "./format";

const PHASE_RANK = {
  queued: 0,
  baseline: 1,
  mutations: 2,
  proposal: 3,
  verification: 4,
  done: 5,
};

function rank(phase) {
  return PHASE_RANK[phase] ?? 0;
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isActive(status) {
  return status === "queued" || status === "running" || status === "repairing";
}

function stepDuration(run, needle) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (
      step &&
      typeof step.key === "string" &&
      step.key.toLowerCase().includes(needle) &&
      typeof step.ms === "number"
    ) {
      return step.ms;
    }
  }
  return null;
}

export function mutationCounts(run) {
  const mutations = Array.isArray(run?.mutations) ? run.mutations : [];
  const scan = run?.scan ?? {};
  const derived = { tested: 0, caught: 0, missed: 0, errors: 0, timeouts: 0, untested: 0 };

  for (const mutation of mutations) {
    const status = mutation?.status ?? "untested";
    if (status === "untested") {
      derived.untested += 1;
      continue;
    }
    if (status === "caught") derived.caught += 1;
    else if (status === "missed") derived.missed += 1;
    else if (status === "error") derived.errors += 1;
    else if (status === "timeout") derived.timeouts += 1;
    derived.tested += 1;
  }

  return {
    total: mutations.length,
    tested: typeof scan.tested === "number" ? scan.tested : derived.tested,
    caught: typeof scan.caught === "number" ? scan.caught : derived.caught,
    missed: typeof scan.missed === "number" ? scan.missed : derived.missed,
    errors: typeof scan.errors === "number" ? scan.errors : derived.errors,
    timeouts: typeof scan.timeouts === "number" ? scan.timeouts : derived.timeouts,
    untested: typeof scan.untested === "number" ? scan.untested : derived.untested,
    durationMs: typeof scan.durationMs === "number" ? scan.durationMs : null,
  };
}

function baselinePhase(run) {
  const baseline = run.baseline;
  const counts = baseline?.counts ?? {};
  const total = num(counts.total);
  const passed = num(counts.passed);
  const failed = num(counts.failed);
  const skipped = num(counts.skipped);
  const durationMs = typeof baseline?.durationMs === "number" ? baseline.durationMs : null;

  const countText = baseline
    ? `${total} ${total === 1 ? "test" : "tests"} · ${passed} passed · ${failed} failed${
        skipped > 0 ? ` · ${skipped} skipped` : ""
      }`
    : null;

  if (baseline) {
    if (baseline.outcome === "timeout") {
      return {
        status: "timeout",
        detail: "The submitted suite did not finish against the submitted code.",
        durationMs,
      };
    }
    if (baseline.outcome === "error") {
      return {
        status: "failed",
        detail: baseline.error || "The submitted suite could not run against the submitted code.",
        durationMs,
      };
    }
    if (failed > 0) {
      return {
        status: "failed",
        detail: `${countText}. The scan stopped before mutating.`,
        durationMs,
      };
    }
    if (total === 0) {
      return {
        status: "failed",
        detail: "No tests ran, so there is nothing to compare.",
        durationMs,
      };
    }
    return {
      status: "done",
      detail: `${countText}. The suite passes against the submitted code.`,
      durationMs,
    };
  }

  if (run.failure) {
    return {
      status: "failed",
      detail: run.failure.message || "The run failed before the baseline finished.",
      durationMs: null,
    };
  }

  if (run.phase === "queued" || run.status === "queued") {
    return { status: "pending", detail: "Waiting for a worker.", durationMs: null };
  }
  if (run.phase === "baseline") {
    if (run.status === "cancelled") {
      return {
        status: "skipped",
        detail: "Stopped before the baseline finished.",
        durationMs: null,
      };
    }
    return {
      status: "running",
      detail: "Running the submitted suite against the submitted code.",
      durationMs: null,
    };
  }
  return {
    status: rank(run.phase) > rank("baseline") ? "done" : "pending",
    detail:
      rank(run.phase) > rank("baseline")
        ? "Completed."
        : "Runs first, before any mutation.",
    durationMs: null,
  };
}

function mutationsPhase(run, counts) {
  const stop = run.scan?.stopReason;
  const mutationMs = (Array.isArray(run.mutations) ? run.mutations : []).reduce(
    (total, mutation) =>
      total + (typeof mutation?.durationMs === "number" ? mutation.durationMs : 0),
    0,
  );
  const durationMs = counts.durationMs ?? (mutationMs || null);

  if (stop === "baseline_failed" || stop === "no_tests") {
    return { status: "skipped", detail: "Skipped: the baseline did not pass.", durationMs: null };
  }
  if (stop === "no_mutations") {
    return {
      status: "done",
      detail: "No mutable comparison or logical operators were found.",
      durationMs,
    };
  }
  if (run.scan) {
    const deadline = stop === "deadline" ? ` Scan stopped at the deadline; ${counts.untested} untested.` : "";
    return {
      status: "done",
      detail: `${counts.tested} of ${counts.total} tested · ${counts.caught} caught · ${counts.missed} missed.${deadline}`,
      durationMs,
    };
  }
  if (run.failure && run.phase === "mutations") {
    return {
      status: "failed",
      detail: run.failure.message || "The mutation scan failed.",
      durationMs: stepDuration(run, "mutation"),
    };
  }
  if (run.phase === "mutations") {
    return {
      status: "running",
      detail:
        counts.total > 0
          ? `${counts.tested} of ${counts.total} tested so far · ${counts.caught} caught · ${counts.missed} missed.`
          : "Generating mutations and running the suite against each one.",
      durationMs: stepDuration(run, "mutation"),
    };
  }
  if (rank(run.phase) > rank("mutations")) {
    return { status: "done", detail: "Completed.", durationMs };
  }
  return {
    status: "pending",
    detail: "Each mutant is executed once against the submitted suite.",
    durationMs: null,
  };
}

function proposalPhase(run) {
  const repair = run.repair;
  const requested = Boolean(run.repairRequestedFor) || Boolean(repair);
  const attempts = Array.isArray(repair?.attempts) ? repair.attempts : [];
  const durationMs = attempts.reduce(
    (total, attempt) => total + (typeof attempt?.durationMs === "number" ? attempt.durationMs : 0),
    0,
  );

  if (!requested) {
    return {
      status: "idle",
      detail: "Requested only after a missed mutation is selected.",
      durationMs: null,
    };
  }

  if (!repair) {
    return { status: "running", detail: "Waiting for the model.", durationMs: null };
  }

  if (repair.status === "queued") {
    if (attempts.length > 0 || run.status === "repairing") {
      return {
        status: "running",
        detail:
          attempts.length > 0
            ? `${attempts.length} attempt${attempts.length === 1 ? "" : "s"} so far. The model is trying again.`
            : "The model is drafting a test.",
        durationMs: durationMs || null,
      };
    }
    return { status: "pending", detail: "Waiting for a repair slot.", durationMs: null };
  }

  if (repair.status === "running" && !repair.proposal && attempts.length === 0) {
    return {
      status: "running",
      detail: "The model is drafting a test.",
      durationMs: null,
    };
  }

  if (repair.proposal) {
    return {
      status: "done",
      detail: `${attempts.length || 1} model ${attempts.length === 1 ? "attempt" : "attempts"} · ${repair.proposal.title}`,
      durationMs: durationMs || null,
    };
  }

  if (attempts.length > 0) {
    return {
      status: repair.status === "running" ? "running" : "failed",
      detail:
        repair.status === "running"
          ? `${attempts.length} attempt${attempts.length === 1 ? "" : "s"} so far. The model is trying again.`
          : `${attempts.length} model attempt${attempts.length === 1 ? "" : "s"}, no valid proposal.`,
      durationMs: durationMs || null,
    };
  }

  if (repair.failure) {
    return {
      status: "failed",
      detail: repair.failure,
      durationMs: null,
    };
  }

  return { status: "running", detail: "The model is drafting a regression test.", durationMs: null };
}

function verificationPhase(run) {
  const repair = run.repair;
  const requested = Boolean(run.repairRequestedFor) || Boolean(repair);
  const verification = repair?.verification;
  const matrix = Array.isArray(verification?.matrix) ? verification.matrix : [];

  if (!requested) {
    return {
      status: "idle",
      detail: "Runs the proposed test through four executions.",
      durationMs: null,
    };
  }

  const matrixMs = matrix.reduce(
    (total, row) => total + (typeof row?.durationMs === "number" ? row.durationMs : 0),
    0,
  );
  const durationMs = matrixMs || stepDuration(run, "verif") || null;

  if (verification) {
    if (verification.status === "verified" && repair?.status === "error") {
      return {
        status: "failed",
        detail: repair.failure || "Verification passed, but the artifacts could not be built.",
        durationMs,
      };
    }
    if (verification.status === "verified") {
      return {
        status: "verified",
        detail: "All four checks matched expectations.",
        durationMs,
      };
    }
    if (verification.status === "mismatch") {
      return {
        status: "mismatch",
        detail: "The proposed test does not hold against the original implementation.",
        durationMs,
      };
    }
    if (verification.status === "rejected") {
      return {
        status: "failed",
        detail:
          verification.detail ||
          "The proposed test did not fail the mutant on its own new assertion.",
        durationMs,
      };
    }
    return {
      status: "failed",
      detail: verification.detail || "Verification could not complete.",
      durationMs,
    };
  }

  if (repair?.status === "rejected" || repair?.status === "error" || repair?.status === "timeout") {
    return {
      status: "skipped",
      detail:
        repair.status === "rejected"
          ? "Not run: no valid proposal was produced."
          : "Not run: the repair did not reach verification.",
      durationMs: null,
    };
  }

  if (repair?.proposal) {
    return {
      status: "running",
      detail: "Executing original, mutant, original with the new test, and mutant with the new test.",
      durationMs,
    };
  }

  return {
    status: "pending",
    detail: "Waiting for a valid proposal.",
    durationMs: null,
  };
}

function runStatus(run) {
  if (!run) return { status: "not_started", label: "No run" };
  if (run.failure) return { status: "failed" };
  if (run.status === "cancelled") return { status: "cancelled", label: "Stopped" };
  const stop = run.scan?.stopReason;
  if (
    run.status === "completed" &&
    (stop === "baseline_failed" || stop === "no_tests" || stop === "deadline")
  ) {
    return { status: "timeout", label: "Stopped early" };
  }
  return { status: run.status ?? "queued" };
}

function liveText(run, counts) {
  if (!run) {
    return "No run yet. Each check compares your tests against generated mutants.";
  }
  if (run.status === "queued") {
    return "Queued. Waiting for a worker to start the baseline.";
  }
  if (run.status === "failed") {
    return run.failure?.message ? `Run failed: ${run.failure.message}` : "The run failed before a result.";
  }
  if (run.status === "cancelled") {
    return "Stopped. The current execution finished and its environment was cleaned up; results collected before the stop are shown.";
  }
  if (run.status === "repairing") {
    if (run.repair?.verification) return "Verification: executing the four-step matrix.";
    return "Repair: the model is drafting a regression test.";
  }
  if (run.status === "running") {
    if (run.phase === "baseline") {
      return "Baseline: running the submitted suite against the submitted code.";
    }
    if (run.phase === "mutations") {
      return counts.total > 0
        ? `Mutations: ${counts.tested} of ${counts.total} tested, ${counts.caught} caught, ${counts.missed} missed.`
        : "Mutations: generating operators and testing each mutant.";
    }
    if (run.phase === "proposal") return "Repair: waiting for a valid proposal.";
    if (run.phase === "verification") return "Verification: executing the four-step matrix.";
    return "Run in progress.";
  }

  const stop = run.scan?.stopReason;
  if (stop === "baseline_failed") {
    return "Scan stopped: the baseline suite failed. Nothing was mutated.";
  }
  if (stop === "no_tests") {
    return "Scan stopped: no tests ran. Nothing was mutated.";
  }
  if (stop === "deadline") {
    return `Scan stopped at the deadline. ${counts.untested} untested, never counted as caught.`;
  }
  if (stop === "no_mutations") {
    return "Scan complete: no mutable comparison or logical operators were found.";
  }
  if (run.scan) {
    const verified = run.repair?.status === "verified" ? " Repair verified." : "";
    return `Scan complete: ${counts.caught} of ${counts.tested} tested mutations caught, ${counts.missed} missed.${verified}`;
  }
  return "Run complete.";
}

export default function RunProgress({ run }) {
  const active = Boolean(run) && isActive(run.status);
  const [now, setNow] = useState(null);

  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  const counts = mutationCounts(run);
  const baseline = baselinePhase(run ?? {});
  const mutations = mutationsPhase(run ?? {}, counts);
  const proposal = proposalPhase(run ?? {});
  const verification = verificationPhase(run ?? {});
  const phases = [
    { key: "baseline", label: "Baseline", ...baseline },
    { key: "mutations", label: "Mutations", ...mutations },
    { key: "proposal", label: "Proposal", ...proposal },
    { key: "verification", label: "Verification", ...verification },
  ];

  const overall = runStatus(run);
  const end = run ? (isActive(run.status) ? now ?? run.createdAt : run.updatedAt) : null;
  const elapsed =
    run && typeof run.createdAt === "number" && typeof end === "number"
      ? Math.max(0, end - run.createdAt)
      : null;

  return (
    <section className="panel progress" aria-labelledby="progress-heading">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Run</p>
          <h2 id="progress-heading">Progress</h2>
        </div>
        <div className="progress-meta">
          {run?.id ? <span className="progress-id">{run.id}</span> : null}
          <StatusBadge status={overall.status} label={overall.label} />
          {elapsed !== null ? <span>Elapsed {formatDuration(elapsed)}</span> : null}
        </div>
      </div>

      <p className="progress-live" role="status" aria-live="polite">
        {liveText(run, counts)}
      </p>

      <ol className="phase-list">
        {phases.map((phase, index) => (
          <li className={`phase phase--${phase.status}`} key={phase.key}>
            <span className="phase-index" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <div className="phase-main">
              <div className="phase-top">
                <span className="phase-label">{phase.label}</span>
                <StatusBadge status={phase.status} />
                {typeof phase.durationMs === "number" ? (
                  <span className="phase-duration">{formatDuration(phase.durationMs)}</span>
                ) : null}
              </div>
              {!["pending", "not_started", "idle", "skipped"].includes(phase.status) && phase.detail ? (
                <p className="phase-detail">{phase.detail}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
