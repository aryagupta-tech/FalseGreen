"use client";

import { useState } from "react";

const INSTALL_COMMAND = `git clone https://github.com/aryagupta-tech/falsegreen.git
cd falsegreen
npm ci`;

const SCAN_COMMAND = `npm run cli -- scan --local \\
  --source examples/terminal/source.js \\
  --tests examples/terminal/source.test.js \\
  --requirement @examples/terminal/requirement.txt`;

function CommandBlock({ id, label, command, copyLabel }) {
  const [copyState, setCopyState] = useState("idle");

  async function copyCommand() {
    setCopyState("copying");
    try {
      await navigator.clipboard.writeText(command);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div className="cli-command">
      <div className="cli-command-head">
        <h3 id={`${id}-label`}>{label}</h3>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          onClick={copyCommand}
          disabled={copyState === "copying"}
          aria-label={copyLabel}
          aria-describedby={`${id}-status`}
        >
          {copyState === "copied" ? "Copied" : copyState === "copying" ? "Copying…" : "Copy"}
        </button>
      </div>
      <pre tabIndex={0} aria-labelledby={`${id}-label`}>
        <code>{command}</code>
      </pre>
      <p className="cli-copy-status" id={`${id}-status`} role="status">
        {copyState === "failed"
          ? "Clipboard unavailable. Select the command above to copy it."
          : copyState === "copied"
            ? "Copied to clipboard."
            : ""}
      </p>
    </div>
  );
}

export default function CliSection({ version }) {
  return (
    <section className="panel cli-section" id="cli" aria-labelledby="cli-heading">
      <div className="cli-intro">
        <div className="cli-label-row">
          <p className="kicker">FalseGreen CLI</p>
          {version ? <span className="cli-version">v{version}</span> : null}
        </div>
        <h2 id="cli-heading">Keep the checks in your terminal.</h2>
        <p className="cli-lede">
          Run the same mutation checks against files on your laptop. Local scans
          need no server, account, or model.
        </p>
        <dl className="cli-features">
          <div>
            <dt>Scan locally</dt>
            <dd>See the baseline, caught and missed mutations, and execution errors.</dd>
          </div>
          <div>
            <dt>Verify a regression test</dt>
            <dd>
              Use <code>check</code> in place of <code>scan</code> to propose a test,
              run the verification matrix, and save a verified patch.
            </dd>
          </div>
          <div>
            <dt>Use your own model</dt>
            <dd>
              Repairs need a configured model endpoint. Local Ollama is supported.
            </dd>
          </div>
        </dl>
        <a
          className="cli-docs-link"
          href="https://github.com/aryagupta-tech/falsegreen#cli"
          target="_blank"
          rel="noreferrer"
        >
          Read the CLI guide <span aria-hidden="true">↗</span>
        </a>
      </div>
      <div className="cli-quickstart">
        <p className="cli-requirements">Node.js 24.11+ recommended · npm · Git</p>
        <CommandBlock
          id="cli-install"
          label="1. Get the CLI"
          command={INSTALL_COMMAND}
          copyLabel="Copy installation commands"
        />
        <CommandBlock
          id="cli-scan"
          label="2. Run the included example"
          command={SCAN_COMMAND}
          copyLabel="Copy example scan command"
        />
        <p className="cli-example-note">
          The example finds a missed shipping boundary and exits with code <code>2</code>.
          Change the three paths to check your own module, Vitest file, and requirement.
        </p>
      </div>
    </section>
  );
}
