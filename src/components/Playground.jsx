"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CodeEditor from "./CodeEditor";
import Downloads from "./Downloads";
import HowItWorks from "./HowItWorks";
import MutationList from "./MutationList";
import RepairPanel from "./RepairPanel";
import RunProgress from "./RunProgress";
import ScanSummary from "./ScanSummary";
import StatusBadge from "./StatusBadge";

const POLL_MS = 700;

const FALLBACK_LIMITS = {
  maxSourceBytes: 65536,
  maxTestsBytes: 65536,
  maxRequirementBytes: 4096,
  maxMutations: 12,
  testTimeoutMs: 10000,
};

const encoder = new TextEncoder();

function byteLength(value) {
  return encoder.encode(value ?? "").length;
}

function isActiveStatus(status) {
  return status === "queued" || status === "running" || status === "repairing";
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function defaultMessage(status) {
  if (status === 400) return "The run was rejected. Correct the highlighted input and try again.";
  if (status === 409) return "The run changed while you were acting. Wait for the current step to finish.";
  if (status === 429) return "Too many runs from this browser this hour. Try again later.";
  if (status === 404) return "The run was not found. It may have expired.";
  if (status === 503) return "The server is missing required configuration.";
  return "The request failed.";
}

function normalizeApiError(status, payload) {
  const raw = payload && typeof payload === "object" ? payload.error : null;
  if (raw && typeof raw === "object") {
    return {
      status,
      code: typeof raw.code === "string" ? raw.code : "request_failed",
      message: typeof raw.message === "string" && raw.message ? raw.message : defaultMessage(status),
      details: raw.details ?? null,
    };
  }
  return {
    status,
    code: "request_failed",
    message: defaultMessage(status),
    details: null,
  };
}

function fieldErrorsFrom(error) {
  if (!error?.details) return {};
  const details = error.details;
  const list = Array.isArray(details)
    ? details
    : Array.isArray(details?.errors)
      ? details.errors
      : [];
  const map = {};
  for (const item of list) {
    if (item && typeof item.field === "string" && item.field) {
      map[item.field] = typeof item.message === "string" ? item.message : "Invalid value.";
    }
  }
  return map;
}

function alertLabel(error) {
  if (!error) return "Request failed";
  if (error.code === "not_configured") return "Not configured";
  if (error.status === 429) return "Rate limited";
  if (error.status === 409) return "Conflict";
  if (error.status === 400) return "Input rejected";
  if (error.status === 404) return "Run not found";
  return "Request failed";
}

function isWarning(error) {
  return (
    Boolean(error) &&
    (error.status === 429 ||
      error.status === 409 ||
      error.code === "not_configured" ||
      error.code === "rate_limited")
  );
}

function ByteCounter({ value, max }) {
  const bytes = byteLength(value);
  const over = bytes > max;
  return (
    <span
      className={`counter${over ? " counter--over" : ""}`}
      aria-label={`${bytes} of ${max} bytes used`}
    >
      {bytes} / {max} bytes
    </span>
  );
}

export default function Playground({ initialPreset = null, presets = [], publicConfig = {} }) {
  const presetList = Array.isArray(presets) ? presets : [];
  const basePreset = initialPreset ?? presetList[0] ?? null;

  const [presetId, setPresetId] = useState(basePreset?.id ?? "");
  const [requirement, setRequirement] = useState(basePreset?.requirement ?? "");
  const [source, setSource] = useState(basePreset?.source ?? "");
  const [tests, setTests] = useState(basePreset?.tests ?? "");
  const [activeTab, setActiveTab] = useState("source");

  const [run, setRun] = useState(null);
  const [runId, setRunId] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [pollError, setPollError] = useState(null);
  const [selectedMutationId, setSelectedMutationId] = useState(null);
  const [repairPendingId, setRepairPendingId] = useState(null);
  const [repairError, setRepairError] = useState(null);
  const [cancelPending, setCancelPending] = useState(false);

  const submitSequence = useRef(0);
  const submitRef = useRef(null);
  const runIdRef = useRef(null);
  const autoSelectedRun = useRef(null);

  useEffect(() => {
    runIdRef.current = runId;
  }, [runId]);

  const limits = useMemo(() => ({ ...FALLBACK_LIMITS, ...(publicConfig?.limits ?? {}) }), [publicConfig]);
  const pollMs =
    typeof publicConfig?.pollIntervalMs === "number" && publicConfig.pollIntervalMs > 0
      ? publicConfig.pollIntervalMs
      : POLL_MS;

  const runActive = Boolean(run) && isActiveStatus(run.status);
  const busy = submitting || runActive;

  const selectedMutation =
    (Array.isArray(run?.mutations) ? run.mutations : []).find(
      (mutation) => mutation?.id === selectedMutationId,
    ) ?? null;

  const fieldErrors = useMemo(() => fieldErrorsFrom(submitError), [submitError]);

  const changedSinceRun =
    Boolean(run?.input) &&
    (run.input.requirement !== requirement ||
      run.input.source !== source ||
      run.input.tests !== tests);

  function clearRunState() {
    setRun(null);
    setRunId(null);
    runIdRef.current = null;
    setSelectedMutationId(null);
    setSubmitError(null);
    setPollError(null);
    setRepairError(null);
    setRepairPendingId(null);
    autoSelectedRun.current = null;
  }

  function invalidateSubmission() {
    submitSequence.current += 1;
    setSubmitting(false);
  }

  function selectPreset(preset) {
    if (!preset) return;
    invalidateSubmission();
    clearRunState();
    setPresetId(preset.id ?? "");
    setRequirement(preset.requirement ?? "");
    setSource(preset.source ?? "");
    setTests(preset.tests ?? "");
  }

  function handleReset() {
    const preset = presetList.find((item) => item?.id === presetId) ?? basePreset ?? presetList[0];
    if (preset) {
      selectPreset(preset);
      return;
    }
    invalidateSubmission();
    clearRunState();
    setRequirement("");
    setSource("");
    setTests("");
  }

  async function handleSubmit(event) {
    event?.preventDefault?.();
    if (busy) return;

    const sequence = submitSequence.current + 1;
    submitSequence.current = sequence;

    setSubmitting(true);
    setSubmitError(null);
    setPollError(null);
    setRepairError(null);
    setRepairPendingId(null);
    setSelectedMutationId(null);
    setRun(null);
    setRunId(null);

    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ requirement, source, tests }),
        cache: "no-store",
      });
      const payload = await readJson(response);

      if (submitSequence.current !== sequence) return;

      if (!response.ok) {
        setSubmitError(normalizeApiError(response.status, payload));
        return;
      }

      const nextRunId = payload?.runId ?? payload?.run?.id ?? null;
      if (!nextRunId) {
        setSubmitError({
          status: 0,
          code: "missing_run_id",
          message: "The server accepted the request but did not return a run identifier.",
          details: null,
        });
        return;
      }

      runIdRef.current = nextRunId;
      setRunId(nextRunId);
      setRun(payload?.run ?? null);
    } catch {
      if (submitSequence.current !== sequence) return;
      setSubmitError({
        status: 0,
        code: "network_error",
        message: "Could not reach the server. Check your connection and try again.",
        details: null,
      });
    } finally {
      if (submitSequence.current === sequence) setSubmitting(false);
    }
  }

  useEffect(() => {
    submitRef.current = handleSubmit;
  });

  async function handleRequestRepair(mutationId) {
    if (!runId || !mutationId) return;
    const targetRunId = runId;

    setRepairError(null);
    setRepairPendingId(mutationId);
    setSelectedMutationId(mutationId);

    try {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(targetRunId)}/repairs`,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ mutationId }),
          cache: "no-store",
        },
      );
      const payload = await readJson(response);

      if (runIdRef.current !== targetRunId) return;

      if (!response.ok) {
        setRepairError(normalizeApiError(response.status, payload));
        return;
      }

      if (payload?.run) setRun(payload.run);
    } catch {
      if (runIdRef.current !== targetRunId) return;
      setRepairError({
        status: 0,
        code: "network_error",
        message: "Could not reach the server. Check your connection and try again.",
        details: null,
      });
    } finally {
      if (runIdRef.current === targetRunId) setRepairPendingId(null);
    }
  }

  async function handleCancel() {
    if (!runId || cancelPending) return;
    const targetRunId = runId;
    setCancelPending(true);
    setSubmitError(null);
    try {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(targetRunId)}/cancel`,
        { method: "POST", cache: "no-store", headers: { accept: "application/json" } },
      );
      const payload = await readJson(response);
      if (runIdRef.current !== targetRunId) return;
      if (!response.ok) {
        setSubmitError(normalizeApiError(response.status, payload));
        return;
      }
      if (payload?.run) setRun(payload.run);
    } catch {
      if (runIdRef.current !== targetRunId) return;
      setSubmitError({
        status: 0,
        code: "network_error",
        message: "Could not reach the server. Check your connection and try again.",
        details: null,
      });
    } finally {
      if (runIdRef.current === targetRunId) setCancelPending(false);
    }
  }

  function handleSelectMutation(mutationId) {
    setSelectedMutationId(mutationId ?? null);
    setRepairError(null);
  }

  useEffect(() => {
    const handleShortcut = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        submitRef.current?.();
      }
    };
    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, []);

  useEffect(() => {
    if (!runId) return undefined;
    if (run && !isActiveStatus(run.status)) return undefined;

    let cancelled = false;
    let timer = null;
    let controller = null;

    const poll = async () => {
      if (cancelled) return;
      controller = new AbortController();
      let stop = false;

      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await readJson(response);

        if (cancelled) return;

        if (response.ok && payload?.run) {
          setRun(payload.run);
          setPollError(null);
          if (!isActiveStatus(payload.run.status)) stop = true;
        } else if (response.status === 404) {
          setPollError(normalizeApiError(response.status, payload));
          stop = true;
        } else {
          setPollError(normalizeApiError(response.status, payload));
        }
      } catch (error) {
        if (cancelled || error?.name === "AbortError") return;
        setPollError({
          status: 0,
          code: "network_error",
          message: "Live updates were interrupted. Retrying while the run is active.",
          details: null,
        });
      }

      if (!cancelled && !stop) {
        timer = setTimeout(poll, pollMs);
      }
    };

    timer = setTimeout(poll, pollMs);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (controller) controller.abort();
    };
  }, [runId, run?.status, pollMs]);

  useEffect(() => {
    if (!run?.id || run.status !== "completed") return;
    if (autoSelectedRun.current === run.id) return;
    autoSelectedRun.current = run.id;
    setSelectedMutationId((current) => {
      if (current) return current;
      const missed = (Array.isArray(run.mutations) ? run.mutations : []).find(
        (mutation) => mutation?.status === "missed",
      );
      return missed?.id ?? current;
    });
  }, [run]);

  const showWarning = isWarning(submitError);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            FG
          </span>
          <span className="brand-name">FalseGreen</span>
        </div>
        <nav className="topnav" aria-label="Links">
          <a href="#how">How it works</a>
          <a
            href="https://github.com/aryagupta-tech/falsegreen"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </nav>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="kicker">Mutation testing for AI-written code</p>
          <h1>
            Your tests pass.
            <br />
            <em>Do they catch anything?</em>
          </h1>
          <p className="hero-lede">
            FalseGreen changes your code on purpose, runs your suite, and shows the changes it
            misses. A repair is offered only after it passes execution.
          </p>
          {presetList.length > 0 ? (
            <div className="hero-presets" role="group" aria-label="Examples">
              <span>Try a case</span>
              {presetList.map((preset) => (
                <button
                  type="button"
                  key={preset.id}
                  className="preset-button"
                  aria-pressed={preset.id === presetId}
                  onClick={() => selectPreset(preset)}
                >
                  {preset.shortLabel ?? preset.label ?? preset.id}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <aside className="hero-scope">
          <span className="scope-label">What it takes</span>
          <p>One ES module. One Vitest file. Named synchronous exports.</p>
          <p className="scope-note">Paste your original prompt as the requirement.</p>
        </aside>
      </section>

      <main>
        <div className="workspace">
          <form className="panel input-panel" onSubmit={handleSubmit} noValidate aria-labelledby="inputs-heading">
            <div className="panel-head">
              <h2 id="inputs-heading">Check a module</h2>
            </div>

            <div className="field">
              <div className="field-head">
                <label className="field-label" htmlFor="requirement">
                  Expected behaviour
                </label>
                <ByteCounter value={requirement} max={limits.maxRequirementBytes} />
              </div>
              <p className="field-helper" id="requirement-helper">
                The only source of intent.
              </p>
              <textarea
                id="requirement"
                value={requirement}
                onChange={(event) => setRequirement(event.target.value)}
                rows={4}
                spellCheck={false}
                aria-describedby={
                  fieldErrors.requirement
                    ? "requirement-helper requirement-error"
                    : "requirement-helper"
                }
                aria-invalid={fieldErrors.requirement ? "true" : undefined}
              />
              {fieldErrors.requirement ? (
                <p className="field-error" id="requirement-error">
                  {fieldErrors.requirement}
                </p>
              ) : null}
            </div>

            <div className="field">
              <div className="editor-tabs" role="tablist" aria-label="Files">
                <button
                  type="button"
                  role="tab"
                  className="editor-tab"
                  aria-selected={activeTab === "source"}
                  onClick={() => setActiveTab("source")}
                >
                  source.js{fieldErrors.source ? " !" : ""}
                </button>
                <button
                  type="button"
                  role="tab"
                  className="editor-tab"
                  aria-selected={activeTab === "tests"}
                  onClick={() => setActiveTab("tests")}
                >
                  source.test.js{fieldErrors.tests ? " !" : ""}
                </button>
                <span className="editor-tab-meta">
                  <ByteCounter
                    value={activeTab === "source" ? source : tests}
                    max={
                      activeTab === "source" ? limits.maxSourceBytes : limits.maxTestsBytes
                    }
                  />
                </span>
              </div>
              <p className="field-helper">
                {activeTab === "source"
                  ? "Named synchronous exports. No imports."
                  : "Import ./source.js. Mocks are rejected."}
              </p>
              {activeTab === "source" ? (
                <CodeEditor
                  value={source}
                  onChange={setSource}
                  ariaLabel="Implementation code, source.js"
                />
              ) : (
                <CodeEditor
                  value={tests}
                  onChange={setTests}
                  ariaLabel="Test code, source.test.js"
                />
              )}
              {activeTab === "source" && fieldErrors.source ? (
                <p className="field-error">{fieldErrors.source}</p>
              ) : null}
              {activeTab === "tests" && fieldErrors.tests ? (
                <p className="field-error">{fieldErrors.tests}</p>
              ) : null}
            </div>

            {submitError ? (
              <div
                className={`alert ${showWarning ? "alert--amber" : "alert--red"}`}
                role="alert"
              >
                <div className="alert-head">
                  <StatusBadge
                    status={showWarning ? "untested" : "failed"}
                    label={alertLabel(submitError)}
                    tone={showWarning ? "amber" : "red"}
                    icon="alert"
                  />
                  {submitError.code ? <span className="code-chip">{submitError.code}</span> : null}
                </div>
                <p>{submitError.message}</p>
                {submitError.status === 429 ? (
                  <p className="alert-note">The limit is per browser session per hour.</p>
                ) : null}
                {submitError.status === 409 ? (
                  <p className="alert-note">
                    Wait for the active step to finish, then check the run again.
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="actions">
              <button type="submit" className="btn btn--primary" disabled={busy}>
                {submitting
                  ? "Starting run…"
                  : runActive
                    ? "Run in progress"
                    : "Check my tests"}
                {!busy ? <kbd>⌘/Ctrl + Enter</kbd> : null}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={handleReset}
                title="Restore the selected preset and clear the current run"
              >
                Reset
              </button>
              {runActive ? (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={handleCancel}
                  disabled={cancelPending || Boolean(run?.cancelRequested)}
                  title="Stop after the current execution finishes"
                >
                  {cancelPending || run?.cancelRequested ? "Stopping…" : "Stop"}
                </button>
              ) : null}
              {runActive ? (
                <p className={`actions-note${changedSinceRun ? " actions-note--warn" : ""}`}>
                  {changedSinceRun
                    ? "Inputs changed while this run is in progress. The results below describe the earlier inputs; the button unlocks when the run finishes."
                    : "A run is in progress. Wait for it to finish before starting another."}
                </p>
              ) : changedSinceRun ? (
                <p className="actions-note actions-note--warn">
                  Inputs changed since this run. Check my tests starts a new run.
                </p>
              ) : (
                <p className="actions-note">
                  Runs execute in a throwaway environment.
                </p>
              )}
            </div>
          </form>

          <section className="results" aria-label="Run results">
            <RunProgress run={run} />

            {pollError ? (
              <div className={`alert ${pollError.status === 404 ? "alert--red" : "alert--amber"}`} role="alert">
                <div className="alert-head">
                  <StatusBadge
                    status={pollError.status === 404 ? "failed" : "timeout"}
                    label={pollError.status === 404 ? "Run unavailable" : "Live updates interrupted"}
                  />
                  {pollError.status ? <span className="code-chip">HTTP {pollError.status}</span> : null}
                </div>
                <p>{pollError.message}</p>
                {pollError.status !== 404 ? (
                  <p className="alert-note">Polling continues while the run is active.</p>
                ) : null}
              </div>
            ) : null}

            <ScanSummary run={run} />

            {run ? (
              <MutationList
                run={run}
                selectedMutationId={selectedMutationId}
                onSelect={handleSelectMutation}
                onRequestRepair={handleRequestRepair}
                repairPendingMutationId={repairPendingId}
                modelConfigured={Boolean(publicConfig?.modelConfigured)}
              />
            ) : null}

            {run && (selectedMutationId || run.repair) ? (
              <RepairPanel
                run={run}
                mutation={selectedMutation}
                onRequest={handleRequestRepair}
                requestPendingId={repairPendingId}
                error={repairError}
                model={publicConfig ?? {}}
              />
            ) : null}

            {run?.repair ? <Downloads run={run} /> : null}
          </section>
        </div>

        <HowItWorks />
      </main>

    </div>
  );
}
