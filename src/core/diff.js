/**
 * Small line diff used by the report and the UI. No dependency, deterministic.
 * Returns hunks with { type: 'context'|'remove'|'add', line, text }.
 */
export function diffLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      matrix[i][j] =
        a[i] === b[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }

  const rows = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ type: "context", line: i + 1, text: a[i] });
      i += 1;
      j += 1;
    } else if (matrix[i + 1][j] >= matrix[i][j + 1]) {
      rows.push({ type: "remove", line: i + 1, text: a[i] });
      i += 1;
    } else {
      rows.push({ type: "add", line: j + 1, text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) {
    rows.push({ type: "remove", line: i + 1, text: a[i] });
    i += 1;
  }
  while (j < b.length) {
    rows.push({ type: "add", line: j + 1, text: b[j] });
    j += 1;
  }
  return rows;
}

/** Collapse a line diff to the changed lines plus one line of context. */
export function compactHunks(rows, context = 1) {
  const keep = new Set();
  rows.forEach((row, index) => {
    if (row.type === "context") return;
    for (let offset = -context; offset <= context; offset += 1) {
      const target = index + offset;
      if (target >= 0 && target < rows.length) keep.add(target);
    }
  });
  return rows.filter((_, index) => keep.has(index));
}

/**
 * Build a git-compatible unified diff that adds one new file.
 * Kept deliberately simple: the only patch FalseGreen offers is additive.
 */
export function unifiedDiffForNewFile(filePath, content, { mode = "100644" } = {}) {
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const header = [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode " + mode,
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
  ].join("\n");
  return `${header}\n${body}\n`;
}
