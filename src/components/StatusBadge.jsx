"use client";

import { humanizeStatus } from "./format";

const STATUS_META = {
  caught: { label: "Caught", tone: "green", icon: "check" },
  missed: { label: "Missed", tone: "red", icon: "x" },
  timeout: { label: "Timed out", tone: "amber", icon: "clock" },
  error: { label: "Execution error", tone: "amber", icon: "alert" },
  untested: { label: "Untested", tone: "muted", icon: "dash" },
  queued: { label: "Queued", tone: "muted", icon: "dot" },
  running: { label: "Running", tone: "active", icon: "dot" },
  repairing: { label: "Repairing", tone: "active", icon: "dot" },
  completed: { label: "Completed", tone: "muted", icon: "check" },
  cancelled: { label: "Stopped", tone: "amber", icon: "dash" },
  failed: { label: "Failed", tone: "red", icon: "x" },
  verified: { label: "Verified", tone: "green", icon: "check" },
  mismatch: { label: "Requirement mismatch", tone: "amber", icon: "alert" },
  rejected: { label: "No verified repair", tone: "red", icon: "x" },
  pending: { label: "Pending", tone: "muted", icon: "dash" },
  done: { label: "Done", tone: "muted", icon: "check" },
  skipped: { label: "Not run", tone: "muted", icon: "dash" },
  idle: { label: "Not requested", tone: "muted", icon: "dash" },
  not_started: { label: "Not started", tone: "muted", icon: "dash" },
  pass: { label: "Pass", tone: "muted", icon: "check" },
  fail: { label: "Fail", tone: "red", icon: "x" },
  "fail-proposed": { label: "Fails on proposed assertion", tone: "amber", icon: "alert" },
};

export function Glyph({ name, className = "" }) {
  const common = {
    viewBox: "0 0 14 14",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true",
    focusable: "false",
    className,
  };

  switch (name) {
    case "check":
      return (
        <svg {...common}>
          <path d="M2.5 7.4 5.7 10.5 11.6 3.6" />
        </svg>
      );
    case "x":
      return (
        <svg {...common}>
          <path d="M3.4 3.4 10.6 10.6M10.6 3.4 3.4 10.6" />
        </svg>
      );
    case "clock":
      return (
        <svg {...common}>
          <circle cx="7" cy="7.3" r="4.9" />
          <path d="M7 4.4v3.2l2.1 1.2" />
        </svg>
      );
    case "alert":
      return (
        <svg {...common}>
          <path d="M7 1.9 12.3 11.4H1.7L7 1.9Z" />
          <path d="M7 5.4v2.5" />
          <circle cx="7" cy="9.8" r="0.45" fill="currentColor" stroke="none" />
        </svg>
      );
    case "dot":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="3.1" fill="currentColor" stroke="none" />
        </svg>
      );
    case "arrow":
      return (
        <svg {...common}>
          <path d="M2.6 7h8.8M8.3 3.9 11.4 7l-3.1 3.1" />
        </svg>
      );
    case "download":
      return (
        <svg {...common}>
          <path d="M7 2v7.2M4.2 6.6 7 9.4l2.8-2.8M2.4 11.6h9.2" />
        </svg>
      );
    case "dash":
    default:
      return (
        <svg {...common}>
          <path d="M3 7h8" />
        </svg>
      );
  }
}

export default function StatusBadge({ status, label, tone, icon, className = "", title }) {
  const meta = STATUS_META[status] ?? {
    label: label ?? humanizeStatus(status),
    tone: "muted",
    icon: "dash",
  };
  const resolvedTone = tone ?? meta.tone;
  const resolvedIcon = icon ?? meta.icon;
  const resolvedLabel = label ?? meta.label;

  return (
    <span
      className={`badge badge--${resolvedTone}${className ? ` ${className}` : ""}`}
      data-status={status ?? "unknown"}
      title={title}
    >
      <Glyph name={resolvedIcon} />
      <span>{resolvedLabel}</span>
    </span>
  );
}
