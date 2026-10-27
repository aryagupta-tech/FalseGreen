#!/usr/bin/env node
/**
 * Local OpenAI-compatible stub used by integration tests and manual checks.
 * It is NOT shipped as a model: it stands in for a competent open model so the
 * full execution path can be exercised without network access.
 *
 * Usage: node tests/support/stub-model.mjs [port]
 */
import { createServer } from "node:http";

const port = Number(process.argv[2]) || 8899;
let requests = 0;

function proposalFor(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const prompt = messages.map((message) => String(message.content ?? "")).join("\n");
  const requirementMatch = prompt.match(
    /REQUIREMENT \(the only source of intended behaviour\):\n([\s\S]*?)\n\nSOURCE UNDER TEST/,
  );
  const requirement = requirementMatch ? requirementMatch[1] : prompt;
  const exportName =
    (prompt.match(/EXPORTED FUNCTIONS:\n([A-Za-z_$][\w$]*)/) || [])[1] ||
    (prompt.match(/export function ([A-Za-z_$][\w$]*)/) || [])[1] ||
    "fn";
  const exclusive =
    /above\s*₹?\s*1,?000/i.test(requirement) && !/or more|at least|and above/i.test(requirement);
  return {
    title: exclusive
      ? "charges shipping at exactly 1000 when the rule is exclusive"
      : "gives free shipping at exactly 1000",
    exportName,
    args: [1000],
    expected: exclusive ? 99 : 0,
    rationale: exclusive
      ? "The requirement excludes exactly 1,000, so shipping is charged."
      : "The requirement includes the exact threshold, so shipping is free.",
  };
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, requests }));
    return;
  }
  if (request.method !== "POST" || !request.url.endsWith("/chat/completions")) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
    return;
  }
  let raw = "";
  request.on("data", (chunk) => {
    raw += chunk;
  });
  request.on("end", () => {
    requests += 1;
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid json" }));
      return;
    }
    const mode = process.env.STUB_MODE || "valid";
    if (mode === "hang") return;
    if (mode === "invalid") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "stub-invalid",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "Sure! Here is a test: expect(1).toBe(1)" },
            },
          ],
        }),
      );
      return;
    }
    if (mode === "error") {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "provider unavailable" } }));
      return;
    }
    const proposal = proposalFor(body);
    if (mode === "wrong-export") proposal.exportName = "notExported";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "stub-1",
        model: body.model || "stub-model",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify(proposal) },
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    );
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`stub model listening on http://127.0.0.1:${port}/v1`);
});
