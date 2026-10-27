import fs from "node:fs";
import path from "node:path";

import { unifiedDiffForNewFile } from "./diff.js";
import { ValidationError } from "./errors.js";
import { parseModule } from "./validate-input.js";

function assertPortablePath(filePath) {
  if (/[#?%\u0000-\u001f\u007f]/.test(filePath)) {
    throw new ValidationError("Local module and artifact paths cannot contain #, ?, %, or control characters. Rename the path before running FalseGreen.");
  }
}

/** Normalize only static imports of the selected file, never strings or comments. */
export function normalizeLocalTests({ tests, sourcePath, testsPath }) {
  const sourceFile = fs.realpathSync(sourcePath);
  assertPortablePath(sourceFile);
  const testsDir = path.dirname(fs.realpathSync(testsPath));
  const edits = [];
  for (const node of parseModule(tests).program.body) {
    if (node.type !== "ImportDeclaration" || node.source.value === "vitest") continue;
    const specifier = node.source.value;
    let matches = false;
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      try {
        matches = fs.realpathSync(path.resolve(testsDir, decodeURIComponent(specifier))) === sourceFile;
      } catch {
        // Missing or unrelated imports are rejected below before execution.
      }
    }
    if (!matches) {
      throw new ValidationError(
        `Tests may import only "vitest" and the selected source file. Found ${JSON.stringify(specifier)}.`,
      );
    }
    edits.push({ start: node.source.start, end: node.source.end });
  }
  for (const edit of edits.reverse()) {
    tests = tests.slice(0, edit.start) + '"./source.js"' + tests.slice(edit.end);
  }
  return tests;
}

function sourceSpecifier(fromDir, sourcePath) {
  const relative = path.relative(fromDir, sourcePath).split(path.sep).join("/");
  const prefix = relative.startsWith("../") ? "" : "./";
  return prefix + relative;
}

/** Project the verified fixed template onto the user's paths; preserve matrix evidence. */
export function localRepairArtifacts({ run, sourcePath, testsPath, originalTests, outDir, patchRoot }) {
  const artifacts = run.repair?.artifacts;
  const generated = artifacts?.["falsegreen.generated.test.js"];
  if (run.repair?.status !== "verified" || typeof generated !== "string") {
    throw new Error("Only a verified repair can produce local artifacts.");
  }
  sourcePath = fs.realpathSync(sourcePath);
  assertPortablePath(sourcePath);
  assertPortablePath(outDir);
  const extension = path.extname(sourcePath);
  const target = (extension ? sourcePath.slice(0, -extension.length) : sourcePath) + `.regression.test${extension || ".js"}`;
  const testFileName = path.relative(patchRoot, target).split(path.sep).join("/");
  if (testFileName === ".." || testFileName.startsWith("../") || path.isAbsolute(testFileName)) {
    throw new Error("The regression test must be inside the patch root.");
  }
  const patchTest = generated.replace('"./source.js"', () => JSON.stringify(sourceSpecifier(path.dirname(target), sourcePath)));
  const savedTest = generated.replace('"./source.js"', () => JSON.stringify(sourceSpecifier(outDir, sourcePath)));
  const evidence = JSON.parse(artifacts["falsegreen.evidence.json"]);
  evidence.local = {
    sourcePath,
    testsPath: path.resolve(testsPath),
    originalTests,
    patchRoot,
    testFileName,
    generatedTest: patchTest,
  };
  return {
    "falsegreen.generated.test.js": savedTest,
    "falsegreen.patch": unifiedDiffForNewFile(testFileName, patchTest),
    "falsegreen.evidence.json": `${JSON.stringify(evidence, null, 2)}\n`,
  };
}
