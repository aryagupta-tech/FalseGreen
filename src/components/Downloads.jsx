"use client";

import { Glyph } from "./StatusBadge";

const FILES = [
  {
    name: "falsegreen.generated.test.js",
    href: "test",
    label: "Regression test",
    hint: "Vitest file for the verified assertion",
  },
  {
    name: "falsegreen.patch",
    href: "patch",
    label: "Patch",
    hint: "Adds the test file; does not modify source",
  },
  {
    name: "falsegreen.evidence.json",
    href: "evidence",
    label: "Evidence",
    hint: "Run record, proposal and verification matrix",
  },
];

export default function Downloads({ run }) {
  const runId = run?.id;
  const repair = run?.repair;
  const verified = repair?.status === "verified";
  const enabled = Boolean(verified && runId);

  let reason = "Downloads unlock only after a repair is verified.";
  if (!run) {
    reason = "Run a scan and verify a repair to unlock downloads.";
  } else if (run.status === "completed" && !repair) {
    reason = "No repair has been verified for this run.";
  } else if (repair?.status === "mismatch") {
    reason = "The repair ended in a requirement mismatch, so there is no verified test to download.";
  } else if (repair && ["rejected", "error", "timeout"].includes(repair.status)) {
    reason = "The repair did not verify, so no artifact is offered as a fix.";
  } else if (run.status === "failed") {
    reason = "The run failed before a repair was verified.";
  } else if (verified && !runId) {
    reason = "The run identifier is missing, so the artifacts cannot be requested.";
  }

  return (
    <section className="panel downloads" aria-labelledby="downloads-heading">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Artifacts</p>
          <h2 id="downloads-heading">Downloads</h2>
        </div>
        <span className="panel-meta">{enabled ? "Ready" : "Locked"}</span>
      </div>

      <div className="download-list">
        {FILES.map((file) =>
          enabled ? (
            <a
              className="download"
              href={`/api/runs/${encodeURIComponent(runId)}/artifacts/${file.href}`}
              download={file.name}
              aria-describedby="download-reason"
              key={file.href}
            >
              <Glyph name="download" />
              <span className="download-copy">
                <span className="download-name">{file.name}</span>
                <span className="download-hint">
                  {file.label} · {file.hint}
                </span>
              </span>
            </a>
          ) : (
            <button
              type="button"
              className="download download--disabled"
              aria-describedby="download-reason"
              disabled
              key={file.href}
            >
              <Glyph name="download" />
              <span className="download-copy">
                <span className="download-name">{file.name}</span>
                <span className="download-hint">
                  {file.label} · {file.hint}
                </span>
              </span>
            </button>
          ),
        )}
      </div>

      <p className="download-reason" id="download-reason">
        {enabled ? "Generated during verification." : reason}
      </p>
    </section>
  );
}
