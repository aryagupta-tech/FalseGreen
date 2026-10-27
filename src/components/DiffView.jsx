"use client";

import { useMemo } from "react";
import { compactHunks, diffLines } from "@/core/diff";

const MAX_LCS_CELLS = 1500000;

function localRows(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;

  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }

  const rows = [];
  for (let index = Math.max(0, start - 2); index < start; index += 1) {
    rows.push({ type: "context", line: index + 1, text: a[index] });
  }
  for (let index = start; index <= endA; index += 1) {
    rows.push({ type: "remove", line: index + 1, text: a[index] });
  }
  for (let index = start; index <= endB; index += 1) {
    rows.push({ type: "add", line: index + 1, text: b[index] });
  }
  for (let offset = 1; offset <= 2; offset += 1) {
    const beforeIndex = endA + offset;
    const afterIndex = endB + offset;
    if (beforeIndex < a.length && afterIndex < b.length && a[beforeIndex] === b[afterIndex]) {
      rows.push({ type: "context", line: beforeIndex + 1, text: a[beforeIndex] });
    }
  }
  return rows;
}

export default function DiffView({ before = "", after = "", path = "source.js" }) {
  const { rows, omitted, partial } = useMemo(() => {
    const beforeLines = before.split("\n").length;
    const afterLines = after.split("\n").length;

    if (beforeLines * afterLines > MAX_LCS_CELLS) {
      return { rows: localRows(before, after), omitted: null, partial: true };
    }

    const all = diffLines(before, after);
    const compact = compactHunks(all, 2);
    return { rows: compact, omitted: all.length - compact.length, partial: false };
  }, [before, after]);

  return (
    <figure className="diff">
      <figcaption className="diff-head">
        <span className="diff-path">{path}</span>
        <span className="diff-legend">
          <span className="diff-legend-remove">− original</span>
          <span className="diff-legend-add">+ mutant</span>
        </span>
      </figcaption>
      <div className="diff-body" role="group" aria-label={`Line diff of the original and mutant ${path}`}>
        {rows.map((row, index) => {
          const sign = row.type === "add" ? "+" : row.type === "remove" ? "−" : " ";
          return (
            <div
              className={`diff-row diff-row--${row.type}`}
              key={`${row.type}-${row.line}-${index}`}
            >
              <span className="diff-sign" aria-hidden="true">
                {sign}
              </span>
              {row.type !== "context" ? (
                <span className="sr-only">{row.type === "add" ? "Mutant line" : "Original line"}</span>
              ) : null}
              <span className="diff-line" aria-hidden="true">
                {row.line}
              </span>
              <code className="diff-text">{row.text === "" ? " " : row.text}</code>
            </div>
          );
        })}
      </div>
      {partial ? (
        <p className="diff-foot">Showing the changed region; this file is too large for a full line diff.</p>
      ) : omitted > 0 ? (
        <p className="diff-foot">
          {omitted} unchanged {omitted === 1 ? "line" : "lines"} omitted.
        </p>
      ) : null}
    </figure>
  );
}
