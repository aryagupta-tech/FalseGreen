#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

const DEFAULT_URL = "http://localhost:3000";
const COOKIE_NAME = "fg_session";
const SESSION_DIR = path.join(os.homedir(), ".falsegreen");
const SESSION_FILE = path.join(SESSION_DIR, "session");
const MAX_SOURCE_BYTES = 65536;
const MAX_TESTS_BYTES = 65536;
const MAX_REQUIREMENT_BYTES = 4096;
const POLL_MS = 600;
const REQUEST_TIMEOUT_MS = 30000;
const ACTIVE_REPAIR_STATUSES = new Set(["queued", "running"]);
const VALUE_FLAGS = new Set([
  "source",
  "tests",
  "requirement",
  "url",
  "out",
  "mutation",
]);
const BOOLEAN_FLAGS = new Set(["apply", "yes", "json", "help", "local"]);

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

let localController = null;
let interruptedCode = null;
let progressVisible = false;
let progressWidth = 0;
let lastPlainProgress = "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function helpText() {
  return `FalseGreen CLI

Find the mistakes passing tests let through.

Usage:
  falsegreen check --local --source <path> --tests <path> --requirement <text|@file>
  falsegreen scan  --local --source <path> --tests <path> --requirement <text|@file>
  falsegreen check --source <path> --tests <path> --requirement <text|@file> [--url <base>]
  falsegreen check --help
  falsegreen scan --help

Commands:
  check   Scan for missed mutations, then propose and verify one repair.
  scan    Scan for missed mutations without proposing a repair.

Options:
  --source <path>        ES module to mutate. Required.
  --tests <path>         Vitest test file for the module. Required.
  --requirement <value>  Stated behaviour. Use @file to read it from a file. Required.
  --local                Run everything on this machine. No server or deployment.
  --url <base>           Server base URL when --local is not used.
  --out <dir>            Artifact directory. Default ./falsegreen-artifacts.
  --apply                Apply the verified patch with git apply.
  --yes                  Skip the git apply confirmation prompt.
  --json                 Print the final run record as JSON on stdout.
  --mutation <id>        Repair this missed mutation instead of the first one.
  -h, --help             Show this help.

Environment:
  FALSEGREEN_URL         Default server base URL when --url is omitted.
  MODEL_API_BASE_URL     OpenAI-compatible model endpoint for --local repairs.
  MODEL_API_KEY          Bearer token for that endpoint.
  MODEL_ID               Model name.
  Session file           Cookie stored in ~/.falsegreen/session with mode 0600.

Local mode runs the submitted suite in a temporary directory with the local
Vitest install. Scans work without a model; repairs need MODEL_API_* or a local
Ollama endpoint. Supports one self-contained module with named synchronous
exports and one Vitest file. Local tests can import the selected module by its
relative path. A missed mutation identifies a test gap, not proof of a bug.

Limits:
  source and tests       65536 bytes each.
  requirement            4096 bytes.

Exit codes:
  0  Verified repair, or a complete scan with no missed/inconclusive mutations.
  1  Usage, configuration, artifact, patch application, transport or HTTP error.
  2  No verified repair, a missed mutation, or an incomplete/inconclusive scan.
`;
}

function parseArgs(argv) {
  const flags = {};
  let command = null;

  const readValue = (name, inlineValue, index) => {
    if (inlineValue !== undefined) {
      if (inlineValue === "") {
        throw new CliError(`Missing value for --${name}. Run falsegreen --help for usage.`);
      }
      return { value: inlineValue, nextIndex: index };
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--") || next === "-h") {
      throw new CliError(`Missing value for --${name}. Run falsegreen --help for usage.`);
    }
    return { value: next, nextIndex: index + 1 };
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "-h") {
      flags.help = true;
      continue;
    }

    if (argument.startsWith("--")) {
      const separator = argument.indexOf("=");
      const name = separator === -1 ? argument.slice(2) : argument.slice(2, separator);
      const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);

      if (VALUE_FLAGS.has(name)) {
        if (Object.prototype.hasOwnProperty.call(flags, name)) {
          throw new CliError(`--${name} was given more than once. Run falsegreen --help for usage.`);
        }
        const read = readValue(name, inlineValue, index);
        flags[name] = read.value;
        index = read.nextIndex;
        continue;
      }

      if (BOOLEAN_FLAGS.has(name)) {
        if (inlineValue !== undefined) {
          throw new CliError(`--${name} does not take a value. Run falsegreen --help for usage.`);
        }
        if (flags[name]) {
          throw new CliError(`--${name} was given more than once. Run falsegreen --help for usage.`);
        }
        flags[name] = true;
        continue;
      }

      throw new CliError(`Unknown option --${name}. Run falsegreen --help for usage.`);
    }

    if (command === null) {
      command = argument;
      continue;
    }

    throw new CliError(`Unexpected argument ${JSON.stringify(argument)}. Run falsegreen --help for usage.`);
  }

  return { command, flags };
}

function readSession() {
  let text;
  try {
    text = fs.readFileSync(SESSION_FILE, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw new CliError(
      `Could not read the session file at ${SESSION_FILE}: ${error.message}. Check its permissions or remove it.`,
    );
  }

  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    if (name !== COOKIE_NAME) continue;
    const value = line.slice(separator + 1).trim();
    if (value) return value;
  }
  return null;
}

function writeSession(value) {
  const temporary = `${SESSION_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, `${COOKIE_NAME}=${value}`, { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, SESSION_FILE);
    fs.chmodSync(SESSION_FILE, 0o600);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // The temporary file is best effort.
    }
    throw new CliError(
      `Could not save the session at ${SESSION_FILE}: ${error.message}. Check that the directory is writable.`,
    );
  }
}

function sessionCookieFromHeaders(headers) {
  let cookies = [];
  if (typeof headers.getSetCookie === "function") {
    cookies = headers.getSetCookie();
  } else {
    const combined = headers.get("set-cookie");
    if (combined) cookies = combined.split(",");
  }

  for (const cookie of cookies) {
    const pair = String(cookie).split(";")[0];
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    if (pair.slice(0, separator).trim() !== COOKIE_NAME) continue;
    const value = pair.slice(separator + 1).trim();
    if (value) return value;
  }
  return null;
}

function httpError(status, payload, baseUrl) {
  const serverMessage = payload?.error?.message;
  const code = payload?.error?.code;
  const detail = serverMessage || `The server returned HTTP ${status}.`;
  let hint = "";

  if (status === 429) {
    hint = "Too many runs from this session. Wait for the hourly window to reset, then retry.";
  } else if (status === 409) {
    hint = "Wait for the active run or repair to finish, and confirm that the mutation is missed.";
  } else if (status === 503) {
    hint = "The server has no model configured. Set MODEL_API_BASE_URL, MODEL_API_KEY and MODEL_ID, then restart it.";
  } else if (status === 504) {
    hint = "The server timed out. Retry, or check the server logs.";
  } else if (status === 404) {
    hint = "Check the run id and --url. Runs expire and are scoped to one session.";
  } else if (status === 403) {
    hint = "The repair must be verified before its artifacts can be downloaded.";
  } else if (status === 413) {
    hint = "The submitted source, tests, or requirement is too large. Reduce it and retry.";
  } else if (status >= 500) {
    hint = `Retry, or check the server logs for ${baseUrl}.`;
  } else if (status === 400) {
    hint = "Fix the submitted source, tests, or requirement, then retry.";
  }

  const suffix = code ? ` [${code}]` : "";
  return new CliError(`${detail}${hint ? ` ${hint}` : ""}${suffix}`);
}

async function request(pathname, { method = "GET", body, baseUrl, parse = "json" } = {}) {
  const headers = { accept: "application/json" };
  const cookie = readSession();
  if (cookie) headers.cookie = `${COOKIE_NAME}=${cookie}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  let response;
  try {
    response = await fetch(new URL(pathname, `${baseUrl}/`), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CliError(
      `Could not reach FalseGreen at ${baseUrl}. Check --url or FALSEGREEN_URL and that the server is running. (${error.message})`,
    );
  }

  const nextSession = sessionCookieFromHeaders(response.headers);
  if (nextSession) writeSession(nextSession);

  const text = await response.text();

  if (!response.ok) {
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    throw httpError(response.status, payload, baseUrl);
  }

  if (parse === "text") return text;

  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new CliError(`The server returned invalid JSON from ${pathname}. Check --url and retry.`);
  }
}

function resolveBaseUrl(value) {
  if (value !== undefined && String(value).trim() === "") {
    throw new CliError("--url requires a base URL such as http://localhost:3000.");
  }

  const envUrl = process.env.FALSEGREEN_URL && process.env.FALSEGREEN_URL.trim()
    ? process.env.FALSEGREEN_URL
    : undefined;
  const raw = value ?? envUrl ?? DEFAULT_URL;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CliError(`Invalid base URL ${JSON.stringify(raw)}. Use --url http://host:port.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CliError(`Invalid base URL ${JSON.stringify(raw)}. Use an http or https URL.`);
  }

  return parsed.toString().replace(/\/+$/, "");
}

function readModule(flag, filePath, maxBytes, label) {
  if (filePath === undefined) {
    throw new CliError(`Missing --${flag}. Pass --${flag} <path> with an existing ${label.toLowerCase()} file.`);
  }

  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    throw new CliError(
      `${label} file not found: ${filePath}. Pass --${flag} <path> with an existing file.`,
    );
  }

  if (!stats.isFile()) {
    throw new CliError(`${label} path is not a file: ${filePath}. Pass --${flag} <path> to a file.`);
  }

  if (stats.size > maxBytes) {
    throw new CliError(
      `${label} file is ${stats.size} bytes; the limit is ${maxBytes} bytes. Submit a smaller file.`,
    );
  }

  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (error) {
    throw new CliError(`Could not read the ${label.toLowerCase()} file ${filePath}: ${error.message}.`);
  }

  if (buffer.byteLength > maxBytes) {
    throw new CliError(
      `${label} file is ${buffer.byteLength} bytes; the limit is ${maxBytes} bytes. Submit a smaller file.`,
    );
  }

  return buffer.toString("utf8");
}

function readRequirement(value) {
  if (value === undefined) {
    throw new CliError(
      "Missing --requirement. Pass the stated behaviour as text or use --requirement @file.",
    );
  }

  let requirement = value;
  if (value.startsWith("@")) {
    const filePath = value.slice(1);
    if (!filePath) {
      throw new CliError("Missing requirement file after @. Use --requirement @path/to/requirement.txt.");
    }
    requirement = readModule("requirement", filePath, MAX_REQUIREMENT_BYTES, "Requirement");
  }

  if (requirement.trim() === "") {
    throw new CliError(
      "The requirement is empty. Describe the intended behaviour with --requirement <text|@file>.",
    );
  }

  const bytes = Buffer.byteLength(requirement, "utf8");
  if (bytes > MAX_REQUIREMENT_BYTES) {
    throw new CliError(
      `The requirement is ${bytes} bytes; the limit is ${MAX_REQUIREMENT_BYTES} bytes. Shorten it and retry.`,
    );
  }

  return requirement;
}

function writeProgress(text) {
  if (!process.stderr.isTTY) {
    if (text === lastPlainProgress) return;
    lastPlainProgress = text;
    process.stderr.write(`${text}\n`);
    return;
  }

  const padding = Math.max(0, progressWidth - text.length);
  process.stderr.write(`\r${text}${" ".repeat(padding)}`);
  progressWidth = text.length;
  progressVisible = true;
}

function clearProgress() {
  if (progressVisible) {
    process.stderr.write(`\r${" ".repeat(progressWidth)}\r`);
    progressVisible = false;
    progressWidth = 0;
  }
  lastPlainProgress = "";
}

function countMutations(mutations) {
  const counts = { caught: 0, missed: 0, errors: 0, timeouts: 0, untested: 0 };
  for (const mutation of mutations) {
    if (mutation.status === "caught") counts.caught += 1;
    else if (mutation.status === "missed") counts.missed += 1;
    else if (mutation.status === "error") counts.errors += 1;
    else if (mutation.status === "timeout") counts.timeouts += 1;
    else counts.untested += 1;
  }
  return counts;
}

function progressText(run) {
  const parts = [run.phase || run.status || "queued"];

  if (run.baseline) {
    const counts = run.baseline.counts || {};
    const passed = Number(counts.passed) || 0;
    const total = Number(counts.total) || 0;
    const failed = Number(counts.failed) || 0;
    parts.push(`baseline ${passed}/${total} passed${failed ? `, ${failed} failed` : ""}`);
  }

  const mutations = Array.isArray(run.mutations) ? run.mutations : [];
  if (mutations.length > 0) {
    const counts = countMutations(mutations);
    const tested = counts.caught + counts.missed + counts.errors + counts.timeouts;
    parts.push(`mutations ${tested}/${mutations.length} tested, ${counts.caught} caught, ${counts.missed} missed`);
  }

  if (run.repair) {
    const attempts = Array.isArray(run.repair.attempts) ? run.repair.attempts.length : 0;
    parts.push(`repair ${run.repair.status}${attempts ? `, attempt ${attempts}` : ""}`);
    if (run.repair.verification) {
      parts.push(`verification ${run.repair.verification.status}`);
    }
  }

  return `falsegreen  ${parts.join("  |  ")}`;
}

async function pollRun({ runId, baseUrl, done }) {
  for (;;) {
    const data = await request(`/api/runs/${encodeURIComponent(runId)}`, { baseUrl });
    const run = data?.run;
    if (!run) {
      throw new CliError("The server returned a run response without a run record. Check --url.");
    }
    writeProgress(progressText(run));
    if (done(run)) {
      clearProgress();
      return run;
    }
    await sleep(POLL_MS);
  }
}

function formatValue(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

function truncate(text, width) {
  const singleLine = String(text ?? "").replace(/\s+/g, " ").trim();
  if (singleLine.length <= width) return singleLine;
  return `${singleLine.slice(0, Math.max(0, width - 3))}...`;
}

function printBaseline(say, run) {
  const baseline = run.baseline;
  if (!baseline) {
    say("Baseline  not available");
    return;
  }

  const counts = baseline.counts || {};
  const passed = Number(counts.passed) || 0;
  const failed = Number(counts.failed) || 0;
  const skipped = Number(counts.skipped) || 0;
  const total = Number(counts.total) || 0;
  const duration = Math.round(Number(baseline.durationMs) || 0);
  say(
    `Baseline  ${passed} passed  ${failed} failed  ${skipped} skipped  ${total} total  ${baseline.outcome}  ${duration} ms`,
  );
  if (baseline.error) say(`Baseline error: ${baseline.error}`);
}

function printMutations(say, run) {
  const mutations = Array.isArray(run.mutations) ? run.mutations : [];
  say("");
  say("Mutations");

  if (mutations.length === 0) {
    say("  none");
    return;
  }

  const idWidth = Math.max(2, ...mutations.map((mutation) => String(mutation.id || "").length));
  const changeWidth = Math.min(
    64,
    Math.max(6, ...mutations.map((mutation) => truncate(mutation.change, 64).length)),
  );
  const statusWidth = Math.max(
    6,
    ...mutations.map((mutation) => String(mutation.status || "untested").length),
  );

  say(
    `  ${"id".padEnd(idWidth)}  ${"change".padEnd(changeWidth)}  ${"status".padEnd(statusWidth)}  ms`,
  );

  for (const mutation of mutations) {
    const id = String(mutation.id || "").padEnd(idWidth);
    const change = truncate(mutation.change, changeWidth).padEnd(changeWidth);
    const status = String(mutation.status || "untested").padEnd(statusWidth);
    const duration = Number.isFinite(Number(mutation.durationMs))
      ? String(Math.round(Number(mutation.durationMs)))
      : "-";
    say(`  ${id}  ${change}  ${status}  ${duration}`);
  }
}

function printScan(say, run) {
  const scan = run.scan;
  say("");
  if (!scan) {
    say("Scan  not available");
    return;
  }

  say(
    `Scan  ${scan.tested} tested  ${scan.caught} caught  ${scan.missed} missed  ${scan.errors} errors  ${scan.timeouts} timeouts  ${scan.untested} untested  ${Math.round(Number(scan.durationMs) || 0)} ms  stop: ${scan.stopReason}`,
  );

  if (run.failure) {
    say(`Run failed: ${run.failure.message || run.failure.code || "unknown error"}`);
  }
}

function printProposal(say, repair) {
  const proposal = repair.proposal;
  if (!proposal) {
    say("");
    say("Proposal  not available");
    return;
  }

  say("");
  say("Proposal");
  say(`  title: ${proposal.title}`);
  say(`  export: ${proposal.exportName}`);
  say(`  input: ${formatValue(proposal.args)}`);
  say(`  expected: ${formatValue(proposal.expected)}`);
  if (proposal.rationale) say(`  rationale: ${proposal.rationale}`);

  const attempts = Array.isArray(repair.attempts) ? repair.attempts.length : 0;
  if (attempts > 0) say(`  model attempts: ${attempts}`);
}

function printMatrix(say, repair) {
  const matrix = Array.isArray(repair.verification?.matrix) ? repair.verification.matrix : [];
  say("");
  say("Verification matrix");

  if (matrix.length === 0) {
    say("  not available");
    return;
  }

  const labelWidth = Math.max(6, ...matrix.map((row) => String(row.label || "").length));
  const expectedWidth = Math.max(8, ...matrix.map((row) => String(row.expected || "").length));
  const observedWidth = Math.max(8, ...matrix.map((row) => String(row.observed || "").length));
  const statusWidth = Math.max(6, ...matrix.map((row) => String(row.status || "").length));

  say(
    `  ${"row".padEnd(labelWidth)}  ${"expected".padEnd(expectedWidth)}  ${"observed".padEnd(observedWidth)}  ${"status".padEnd(statusWidth)}  ms`,
  );

  for (const row of matrix) {
    const label = String(row.label || "").padEnd(labelWidth);
    const expected = String(row.expected || "").padEnd(expectedWidth);
    const observed = String(row.observed || "").padEnd(observedWidth);
    const status = String(row.status || "").padEnd(statusWidth);
    const duration = Number.isFinite(Number(row.durationMs))
      ? String(Math.round(Number(row.durationMs)))
      : "-";
    say(`  ${label}  ${expected}  ${observed}  ${status}  ${duration}`);
  }
}

async function saveArtifacts({ runId, baseUrl, outDir }) {
  const directory = path.resolve(outDir || "./falsegreen-artifacts");
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch (error) {
    throw new CliError(`Could not create the artifact directory ${directory}: ${error.message}.`);
  }

  const artifacts = [
    ["test", "falsegreen.generated.test.js"],
    ["patch", "falsegreen.patch"],
    ["evidence", "falsegreen.evidence.json"],
  ];
  const paths = {};

  for (const [alias, fileName] of artifacts) {
    const content = await request(
      `/api/runs/${encodeURIComponent(runId)}/artifacts/${alias}`,
      { baseUrl, parse: "text" },
    );
    const target = path.join(directory, fileName);
    try {
      fs.writeFileSync(target, content, "utf8");
    } catch (error) {
      throw new CliError(`Could not write ${target}: ${error.message}. Check the --out directory.`);
    }
    paths[fileName] = target;
  }

  return paths;
}

async function saveLocalArtifacts({ run, flags, originalTests }) {
  const { localRepairArtifacts } = await import("../src/core/cli-files.js");
  const outDir = flags.out;
  let directory = path.resolve(outDir || "./falsegreen-artifacts");
  const sourceDir = path.dirname(fs.realpathSync(flags.source));
  const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", cwd: sourceDir });
  const patchRoot = gitRoot.status === 0 ? gitRoot.stdout.trim() : sourceDir;
  try {
    fs.mkdirSync(directory, { recursive: true });
    directory = fs.realpathSync(directory);
  } catch (error) {
    throw new CliError(`Could not create the artifact directory ${directory}: ${error.message}.`);
  }
  const artifacts = localRepairArtifacts({
    run, sourcePath: flags.source, testsPath: flags.tests, originalTests,
    outDir: directory, patchRoot,
  });

  const inputPaths = [flags.source, flags.tests];
  if (flags.requirement.startsWith("@")) inputPaths.push(flags.requirement.slice(1));
  const inputFiles = inputPaths.map((filePath) => fs.statSync(filePath));
  for (const fileName of Object.keys(artifacts)) {
    const target = path.join(directory, fileName);
    let stats;
    try {
      stats = fs.lstatSync(target);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw new CliError(`Could not inspect artifact path ${target}: ${error.message}.`);
    }
    if (stats.isSymbolicLink() || inputFiles.some((input) => input.dev === stats.dev && input.ino === stats.ino)) {
      throw new CliError(`Refusing to overwrite an input file or symlink at ${target}. Choose another --out directory.`);
    }
  }

  const paths = {};
  for (const fileName of [
    "falsegreen.generated.test.js",
    "falsegreen.patch",
    "falsegreen.evidence.json",
  ]) {
    const content = artifacts[fileName];
    if (typeof content !== "string") {
      throw new CliError(`Missing artifact ${fileName}; the repair is incomplete.`);
    }
    const target = path.join(directory, fileName);
    try {
      fs.writeFileSync(target, content, "utf8");
    } catch (error) {
      throw new CliError(`Could not write ${target}: ${error.message}. Check the --out directory.`);
    }
    paths[fileName] = target;
  }
  return { paths, patchRoot };
}

async function applyPatch({ patchPath, patchContent, assumeYes, say, cwd = process.cwd() }) {
  say("");
  say("Patch");
  say(patchContent.trimEnd());

  if (!assumeYes) {
    if (!process.stdin.isTTY) {
      throw new CliError("--apply needs an interactive terminal or --yes. The verified patch was saved.");
    }
    const prompt = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    let answer = "";
    try {
      answer = await prompt.question("Apply this patch with git apply? [y/N] ", { signal: localController?.signal });
    } finally {
      prompt.close();
    }
    if (!/^y(es)?$/i.test(answer.trim())) {
      say("Patch not applied.");
      return;
    }
  }

  const result = spawnSync("git", ["apply", patchPath], { encoding: "utf8", cwd });
  if (result.error) {
    throw new CliError(`git apply could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new CliError(`git apply failed with exit code ${result.status}.${detail ? ` ${detail}` : ""}`);
  }

  say("Applied patch with git apply.");
}

function chooseMutation(run, requestedId, say) {
  const mutations = Array.isArray(run.mutations) ? run.mutations : [];

  if (requestedId !== undefined) {
    const wanted = requestedId.trim();
    if (wanted === "") {
      throw new CliError("--mutation requires a mutation id such as m1.");
    }
    const selected = mutations.find((mutation) => mutation.id === wanted);
    if (!selected) {
      say(`Mutation ${wanted} was not found in this run.`);
      return null;
    }
    if (selected.status !== "missed") {
      say(`Mutation ${wanted} is ${selected.status}; only a missed mutation can be repaired.`);
      return null;
    }
    return selected;
  }

  return mutations.find((mutation) => mutation.status === "missed") || null;
}

function inconclusiveCount(run) {
  const scan = run.scan || {};
  return (
    (Number(scan.errors) || 0) +
    (Number(scan.timeouts) || 0) +
    (Number(scan.untested) || 0)
  );
}

function scanIsComplete(run) {
  return run.status === "completed" &&
    ["complete", "no_mutations"].includes(run.scan?.stopReason) &&
    run.baseline?.outcome === "completed" &&
    Number(run.baseline.counts?.passed) > 0 &&
    !Number(run.baseline.counts?.failed);
}

function printNoMissedMessage(run, say) {
  const stopReason = run.scan?.stopReason;
  if (stopReason === "baseline_failed") {
    say("The baseline tests did not pass. Fix them before looking for missed mutations.");
    return;
  }
  if (stopReason === "no_tests") {
    say("No tests were found in the test file. Add a test before checking for missed mutations.");
    return;
  }
  if (stopReason === "no_mutations") {
    say("No mutations were available in the source. Add a comparison or logical operator.");
    return;
  }
  if (stopReason === "deadline") {
    say("The scan deadline passed before any missed mutation was found. Retry with a smaller module.");
    return;
  }
  const inconclusive = inconclusiveCount(run);
  if (inconclusive > 0) {
    say(
      `No missed mutations, but ${inconclusive} mutation${inconclusive === 1 ? " was" : "s were"} inconclusive. Timed out, execution error and untested are not evidence either way.`,
    );
    return;
  }
  say("No missed mutations. The existing tests caught every mutant in this run.");
}

async function runLocal(command, flags) {
  const jsonMode = Boolean(flags.json);
  const say = (text = "") => {
    if (jsonMode) process.stderr.write(`${text}\n`);
    else process.stdout.write(`${text}\n`);
  };
  const emitJson = (run) => {
    if (jsonMode) process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  };

  const source = readModule("source", flags.source, MAX_SOURCE_BYTES, "Source");
  const originalTests = readModule("tests", flags.tests, MAX_TESTS_BYTES, "Tests");
  const requirement = readRequirement(flags.requirement);

  const [{ loadConfig }, { createStore }, engine, { createLocalRunner }, { normalizeLocalTests }] = await Promise.all([
    import("../src/core/config.js"),
    import("../src/core/store/index.js"),
    import("../src/core/jobs/engine.js"),
    import("../src/core/execution/local-runner.js"),
    import("../src/core/cli-files.js"),
  ]);
  const tests = normalizeLocalTests({ tests: originalTests, sourcePath: flags.source, testsPath: flags.tests });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "falsegreen-cli-"));
  const controller = new AbortController();
  localController = controller;

  const config = loadConfig({
    ...process.env,
    EXECUTION_DRIVER: "local",
    STORE_DRIVER: "file",
    FG_DATA_DIR: workDir,
    JOB_DRIVER: "inline",
  });
  config.model.signal = controller.signal;
  config.deps = {
    createRunner: () => {
      const runner = createLocalRunner(config);
      return {
        runTests: (input) => runner.runTests({ ...input, signal: controller.signal }),
      };
    },
  };
  const store = createStore(config);

  try {
    const created = await engine.createRun({
      store,
      limits: config.limits,
      sessionId: "cli-local",
      input: { requirement, source, tests },
    });

    await engine.enqueueScan({ store, config, run: created, schedule: false });

    let run = created;
    while (!["completed", "failed", "cancelled"].includes(run.status)) {
      run = await engine.tickScan({ store, config, runId: created.id });
      controller.signal.throwIfAborted();
      writeProgress(progressText(run));
    }
    clearProgress();

    printBaseline(say, run);
    printMutations(say, run);
    printScan(say, run);

    if (command === "scan") {
      if (run.status === "failed") {
        emitJson(run);
        return 2;
      }
      const missed = Number(run.scan?.missed) || 0;
      if (missed > 0) {
        say("");
        say(`${missed} missed mutation${missed === 1 ? "" : "s"} found. Run check to propose a repair.`);
        emitJson(run);
        return 2;
      }
      if (!scanIsComplete(run)) {
        emitJson(run);
        return 2;
      }
      const inconclusive = inconclusiveCount(run);
      if (inconclusive > 0) {
        say("");
        say(
          `${inconclusive} mutation${inconclusive === 1 ? " was" : "s were"} inconclusive. This is not a clean scan.`,
        );
        emitJson(run);
        return 2;
      }
      emitJson(run);
      return 0;
    }

    if (run.status === "failed") {
      say(`Run failed: ${run.failure?.message || "The local scan stopped."}`);
      emitJson(run);
      return 2;
    }

    const mutation = chooseMutation(run, flags.mutation, say);
    if (!mutation) {
      printNoMissedMessage(run, say);
      emitJson(run);
      return 2;
    }

    if (config.model.driver === "unconfigured") {
      emitJson(run);
      throw new CliError(
        "A repair needs a model. Set MODEL_API_BASE_URL, MODEL_API_KEY and MODEL_ID, or use MODEL_DRIVER=ollama with a local model.",
      );
    }

    say("");
    say(`Repairing ${mutation.id}: ${mutation.change}`);

    await engine.requestRepair({
      store,
      limits: config.limits,
      config,
      runId: run.id,
      mutationId: mutation.id,
      schedule: false,
    });

    run = await store.get(engine.runKey(run.id));
    while (
      run.repair &&
      ["queued", "running"].includes(run.repair.status)
    ) {
      run = await engine.tickRepair({ store, config, runId: run.id });
      controller.signal.throwIfAborted();
      writeProgress(progressText(run));
    }
    clearProgress();

    const repair = run.repair;
    if (!repair) {
      say("No verified repair: the local engine did not return a repair record.");
      emitJson(run);
      return 2;
    }

    printProposal(say, repair);
    printMatrix(say, repair);
    say("");

    const status = repair.status || repair.verification?.status;
    if (status === "verified") {
      say("Verified repair.");
      const { paths, patchRoot } = await saveLocalArtifacts({ run, flags, originalTests });
      say("");
      say("Artifacts");
      for (const fileName of Object.keys(paths)) {
        say(`  ${paths[fileName]}`);
      }

      if (flags.apply && paths["falsegreen.patch"]) {
        const patchContent = fs.readFileSync(paths["falsegreen.patch"], "utf8");
        await applyPatch({
          patchPath: paths["falsegreen.patch"],
          patchContent,
          assumeYes: Boolean(flags.yes),
          say,
          cwd: patchRoot,
        });
      }

      emitJson(run);
      return 0;
    }

    if (status === "mismatch") {
      say("Requirement mismatch.");
      const mismatch = repair.verification?.mismatch;
      say(`  requirement: ${mismatch?.requirement ?? run.input?.requirement ?? ""}`);
      say(`  input: ${formatValue(mismatch?.args ?? [])}`);
      say(`  expected: ${formatValue(mismatch?.expected)}`);
      say(`  observed: ${formatValue(mismatch?.observed)}`);
      const reason = repair.failure || repair.verification?.detail;
      if (reason) say(`  reason: ${reason}`);
      emitJson(run);
      return 2;
    }

    say(`No verified repair (${status || "error"}).`);
    const reason = repair.failure || repair.verification?.detail;
    if (reason) say(`Reason: ${reason}`);
    emitJson(run);
    return 2;
  } finally {
    clearProgress();
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
    if (localController === controller) localController = null;
  }
}

async function runCommand(command, flags) {
  if (flags.local) return runLocal(command, flags);

  const jsonMode = Boolean(flags.json);
  const say = (text = "") => {
    if (jsonMode) process.stderr.write(`${text}\n`);
    else process.stdout.write(`${text}\n`);
  };
  const emitJson = (run) => {
    if (jsonMode) process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  };

  const source = readModule("source", flags.source, MAX_SOURCE_BYTES, "Source");
  const tests = readModule("tests", flags.tests, MAX_TESTS_BYTES, "Tests");
  const requirement = readRequirement(flags.requirement);
  const baseUrl = resolveBaseUrl(flags.url);

  const created = await request("/api/runs", {
    method: "POST",
    baseUrl,
    body: { requirement, source, tests },
  });

  const runId = created?.runId || created?.run?.id;
  if (!runId) {
    throw new CliError("The server did not return a run id. Check --url and the server logs.");
  }

  if (created.run) writeProgress(progressText(created.run));

  let run = await pollRun({
    runId,
    baseUrl,
    done: (current) => ["completed", "failed", "cancelled"].includes(current.status),
  });

  printBaseline(say, run);
  printMutations(say, run);
  printScan(say, run);

  if (command === "scan") {
    if (run.status === "failed") {
      emitJson(run);
      return 2;
    }
    const missed = Number(run.scan?.missed) || 0;
    if (missed > 0) {
      say("");
      say(`${missed} missed mutation${missed === 1 ? "" : "s"} found. Run check to propose a repair.`);
      emitJson(run);
      return 2;
    }
    if (!scanIsComplete(run)) {
      emitJson(run);
      return 2;
    }
    const inconclusive = inconclusiveCount(run);
    if (inconclusive > 0) {
      say("");
      say(
        `${inconclusive} mutation${inconclusive === 1 ? " was" : "s were"} inconclusive. This is not a clean scan.`,
      );
      emitJson(run);
      return 2;
    }
    emitJson(run);
    return 0;
  }

  if (run.status === "failed") {
    say(`Run failed: ${run.failure?.message || "The server could not finish the scan."}`);
    emitJson(run);
    return 2;
  }

  const mutation = chooseMutation(run, flags.mutation, say);
  if (!mutation) {
    printNoMissedMessage(run, say);
    emitJson(run);
    return 2;
  }

  say("");
  say(`Repairing ${mutation.id}: ${mutation.change}`);

  const requested = await request(`/api/runs/${encodeURIComponent(runId)}/repairs`, {
    method: "POST",
    baseUrl,
    body: { mutationId: mutation.id },
  });

  if (requested?.run) writeProgress(progressText(requested.run));

  run = await pollRun({
    runId,
    baseUrl,
    done: (current) =>
      current.status === "failed" ||
      !current.repair ||
      !ACTIVE_REPAIR_STATUSES.has(current.repair.status),
  });

  if (run.status === "failed" && !run.repair) {
    say(`Repair failed: ${run.failure?.message || "The server could not finish the repair."}`);
    emitJson(run);
    return 2;
  }

  const repair = run.repair;
  if (!repair) {
    say("No verified repair: the server did not return a repair record.");
    emitJson(run);
    return 2;
  }

  printProposal(say, repair);
  printMatrix(say, repair);

  const status = repair.status || repair.verification?.status;
  say("");

  if (status === "verified") {
    say("Verified repair.");
    const paths = await saveArtifacts({
      runId,
      baseUrl,
      outDir: flags.out,
    });

    say("");
    say("Artifacts");
    for (const fileName of Object.keys(paths)) {
      say(`  ${paths[fileName]}`);
    }

    if (flags.apply) {
      const patchContent = fs.readFileSync(paths["falsegreen.patch"], "utf8");
      await applyPatch({
        patchPath: paths["falsegreen.patch"],
        patchContent,
        assumeYes: Boolean(flags.yes),
        say,
      });
    }

    emitJson(run);
    return 0;
  }

  if (status === "mismatch") {
    say("Requirement mismatch.");
    const mismatch = repair.verification?.mismatch;
    say(`  requirement: ${mismatch?.requirement ?? run.input?.requirement ?? ""}`);
    say(`  input: ${formatValue(mismatch?.args ?? [])}`);
    say(`  expected: ${formatValue(mismatch?.expected)}`);
    say(`  observed: ${formatValue(mismatch?.observed)}`);
    const reason = repair.failure || repair.verification?.detail;
    if (reason) say(`  reason: ${reason}`);
    emitJson(run);
    return 2;
  }

  say(`No verified repair (${status || "error"}).`);
  const reason = repair.failure || repair.verification?.detail;
  if (reason) say(`Reason: ${reason}`);
  emitJson(run);
  return 2;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    clearProgress();
    throw error;
  }

  const { command, flags } = parsed;

  if (flags.help || command === "help") {
    process.stdout.write(helpText());
    return 0;
  }

  if (command === null) {
    process.stderr.write(`${helpText()}\nMissing command. Use check or scan.\n`);
    return 1;
  }

  if (command !== "check" && command !== "scan") {
    throw new CliError(`Unknown command ${JSON.stringify(command)}. Use check or scan.`);
  }

  if (flags.local && flags.url !== undefined) {
    throw new CliError("--local and --url cannot be used together.");
  }
  if (command === "scan") {
    for (const name of ["apply", "mutation", "out"]) {
      if (flags[name] !== undefined) throw new CliError(`--${name} requires the check command.`);
    }
  }
  if (flags.yes && !flags.apply) throw new CliError("--yes requires --apply.");

  return runCommand(command, flags);
}

function interrupt(signal) {
  if (interruptedCode) return;
  interruptedCode = signal === "SIGINT" ? 130 : 143;
  clearProgress();
  process.stderr.write(signal === "SIGINT" ? "Interrupted.\n" : "Terminated.\n");
  if (localController) localController.abort();
  else process.exit(interruptedCode);
}
process.on("SIGINT", () => interrupt("SIGINT"));
process.on("SIGTERM", () => interrupt("SIGTERM"));

main()
  .then((code) => {
    process.exitCode = interruptedCode || code;
  })
  .catch((error) => {
    clearProgress();
    if (interruptedCode) {
      process.exitCode = interruptedCode;
      return;
    }
    if (error instanceof CliError) {
      process.stderr.write(`falsegreen: ${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    process.stderr.write(`falsegreen: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
