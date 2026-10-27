import { randomUUID } from "node:crypto";
import { NotFoundError } from "../core/errors.js";

export const SESSION_COOKIE = "fg_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSessionId(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Parse one cookie out of a Cookie header without depending on Next.
 *
 * @param {string | null | undefined} cookieHeader
 * @param {string} [name]
 * @returns {string | null}
 */
export function parseSessionCookie(cookieHeader, name = SESSION_COOKIE) {
  if (typeof cookieHeader !== "string" || cookieHeader.length === 0) {
    return null;
  }

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    const rawValue = part.slice(separator + 1).trim();
    if (!rawValue) return null;
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }

  return null;
}

/**
 * @param {Record<string, string | undefined>} [env]
 */
export function sessionCookieOptions(env = process.env) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

/**
 * Read the caller's session cookie, creating one when absent. Only call this
 * from a route handler or server action; elsewhere the cookie may be read-only.
 *
 * @returns {Promise<string>}
 */
export async function getSessionId() {
  const { cookies } = await import("next/headers");
  const jar = await cookies();

  const existing = jar.get(SESSION_COOKIE)?.value;
  if (isSessionId(existing)) return existing;

  const sessionId = randomUUID();
  try {
    jar.set({
      name: SESSION_COOKIE,
      value: sessionId,
      ...sessionCookieOptions(),
    });
  } catch {
    // Outside a mutable cookie context the id is still safe to use for this
    // request; the browser simply will not retain it.
  }
  return sessionId;
}

/**
 * Reject missing runs and runs owned by another session with a 404. Ownership
 * failures must not reveal that a run exists.
 *
 * @template {Record<string, unknown>} T
 * @param {T | null | undefined} run
 * @param {string} sessionId
 * @returns {T}
 */
export function requireSameSession(run, sessionId) {
  if (
    !run ||
    typeof run !== "object" ||
    !sessionId ||
    run.sessionId !== sessionId
  ) {
    throw new NotFoundError();
  }
  return run;
}
