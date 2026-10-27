import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CLI = join(process.cwd(), "bin", "falsegreen.js");
const temporaryDirectories = [];

function makeTempDir() {
  const directory = mkdtempSync(join(tmpdir(), "falsegreen-cli-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, ...(options.env || {}) },
  });
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("falsegreen CLI", () => {
  it("prints help for both commands and their flags", () => {
    const result = runCli(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("falsegreen check");
    expect(result.stdout).toContain("falsegreen scan");
    expect(result.stdout).toContain("check   Scan for missed mutations");
    expect(result.stdout).toContain("scan    Scan for missed mutations");

    for (const flag of [
      "--source",
      "--tests",
      "--requirement",
      "--url",
      "--out",
      "--apply",
      "--yes",
      "--json",
      "--mutation",
    ]) {
      expect(result.stdout).toContain(flag);
    }
  });

  it("prints subcommand help without requiring server access", () => {
    for (const command of ["check", "scan"]) {
      const result = runCli([command, "--help"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`falsegreen ${command}`);
      expect(result.stdout).toContain("--source <path>");
    }
  });

  it("exits 1 with a specific message when --source is missing", () => {
    const directory = makeTempDir();
    const tests = join(directory, "source.test.js");
    writeFileSync(tests, 'import { f } from "./source.js";\n', "utf8");

    const result = runCli([
      "check",
      "--tests",
      tests,
      "--requirement",
      "returns one",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing --source");
    expect(result.stderr).toContain("--source <path>");
  });

  it("exits 1 when the source exceeds the byte limit", () => {
    const directory = makeTempDir();
    const source = join(directory, "source.js");
    const tests = join(directory, "source.test.js");
    writeFileSync(source, "x".repeat(65537), "utf8");
    writeFileSync(tests, 'import { f } from "./source.js";\n', "utf8");

    const result = runCli([
      "check",
      "--source",
      source,
      "--tests",
      tests,
      "--requirement",
      "returns one",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("65536");
    expect(result.stderr).toContain("Source file is 65537 bytes");
    expect(result.stderr).toContain("Submit a smaller file");
  });
});
