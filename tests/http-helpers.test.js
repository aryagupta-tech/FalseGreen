import { describe, expect, it } from "vitest";
import {
  MAX_JSON_BYTES,
  handleApi,
  json,
  readJsonBody,
} from "../src/lib/http.js";
import { NotFoundError } from "../src/core/errors.js";
import {
  SESSION_COOKIE,
  isSessionId,
  parseSessionCookie,
  sessionCookieOptions,
} from "../src/lib/session.js";

function jsonRequest(body, contentType = "application/json") {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function catchError(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject.");
}

describe("readJsonBody", () => {
  it("parses a JSON object", async () => {
    await expect(readJsonBody(jsonRequest({ a: 1 }))).resolves.toEqual({ a: 1 });
  });

  it("rejects non-JSON content types", async () => {
    const error = await catchError(readJsonBody(jsonRequest("{}", "text/plain")));
    expect(error.status).toBe(415);
    expect(error.code).toBe("unsupported_media_type");
  });

  it("rejects invalid JSON", async () => {
    const error = await catchError(readJsonBody(jsonRequest("{nope")));
    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_input");
  });

  it("rejects non-object JSON", async () => {
    const error = await catchError(readJsonBody(jsonRequest("[1,2,3]")));
    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_input");
  });

  it("rejects bodies over the byte limit", async () => {
    const error = await catchError(readJsonBody(jsonRequest({ a: "long value" }), 5));
    expect(error.status).toBe(413);
    expect(error.code).toBe("payload_too_large");
  });

  it("defaults to a 256 KiB limit", () => {
    expect(MAX_JSON_BYTES).toBe(256 * 1024);
  });
});

describe("parseSessionCookie", () => {
  it("returns null without a header", () => {
    expect(parseSessionCookie(null)).toBeNull();
    expect(parseSessionCookie("")).toBeNull();
  });

  it("reads the session cookie among others", () => {
    const header = `other=1; ${SESSION_COOKIE}=abc-123; another=2`;
    expect(parseSessionCookie(header)).toBe("abc-123");
  });

  it("returns null when the cookie is absent or empty", () => {
    expect(parseSessionCookie("other=1")).toBeNull();
    expect(parseSessionCookie(`${SESSION_COOKIE}=`)).toBeNull();
  });

  it("accepts a custom cookie name", () => {
    expect(parseSessionCookie("fg_session=x; token=y", "token")).toBe("y");
  });
});

describe("isSessionId", () => {
  it("accepts UUIDs and rejects other values", () => {
    expect(isSessionId("3f9c2b1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b")).toBe(true);
    expect(isSessionId("not-a-uuid")).toBe(false);
    expect(isSessionId(undefined)).toBe(false);
  });
});

describe("sessionCookieOptions", () => {
  it("is httpOnly, lax, and 30 days", () => {
    const options = sessionCookieOptions({});
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.maxAge).toBe(30 * 24 * 60 * 60);
    expect(options.secure).toBe(false);
  });

  it("is secure in production", () => {
    expect(sessionCookieOptions({ NODE_ENV: "production" }).secure).toBe(true);
  });
});

describe("json and handleApi", () => {
  it("sets no-store and the content type", () => {
    const response = json({ ok: true }, 201);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("turns AppError into the contract error envelope", async () => {
    const handler = handleApi(async () => {
      throw new NotFoundError();
    });
    const response = await handler(new Request("http://localhost/api/test"));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "Run not found.", details: null },
    });
  });

  it("hides unexpected errors", async () => {
    const handler = handleApi(async () => {
      throw new Error("secret stack detail");
    });
    const response = await handler(new Request("http://localhost/api/test"));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("internal_error");
    expect(JSON.stringify(body)).not.toContain("secret stack detail");
  });
});
