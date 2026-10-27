export function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60000) return `${Math.round(ms / 1000)} s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatJson(value) {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatInlineJson(value) {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatCount(value, singular, plural = `${singular}s`) {
  const count = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return `${count} ${count === 1 ? singular : plural}`;
}

export function formatTime(epochMs) {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) return "—";
  try {
    return new Date(epochMs).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "—";
  }
}

export function truncate(value, max = 240) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function humanizeStatus(status) {
  if (typeof status !== "string" || !status) return "Unknown";
  const words = status.replace(/[_-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
