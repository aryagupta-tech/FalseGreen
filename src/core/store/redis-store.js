import { Redis } from "@upstash/redis";
import { randomBytes } from "node:crypto";
import { ConfigError, ConflictError } from "../errors.js";

const DEFAULT_LEASE_TTL_MS = 30_000;

const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

const INCREMENT_SCRIPT =
  "local c = redis.call('incr', KEYS[1]) " +
  "local t = redis.call('pttl', KEYS[1]) " +
  "if t < 0 then redis.call('pexpire', KEYS[1], ARGV[1]) end " +
  "return c";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function leaseTtl(ttlMs) {
  const parsed = Number(ttlMs);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_LEASE_TTL_MS;
}

function decode(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * Upstash Redis REST store. Leases use SET NX PX and compare-and-delete; the
 * rate window uses a single Lua increment that keeps the original expiry.
 */
export class RedisStore {
  /**
   * @param {{ redisUrl?: string, redisToken?: string }} [config]
   * @param {{ client?: { get: Function, set: Function, del: Function, eval?: Function, incr?: Function, pexpire?: Function, pttl?: Function } }} [options]
   */
  constructor(config = {}, options = {}) {
    if (options.client) {
      this.client = options.client;
    } else {
      if (!config.redisUrl || !config.redisToken) {
        throw new ConfigError("Redis store requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.");
      }
      this.client = new Redis({ url: config.redisUrl, token: config.redisToken });
    }
  }

  async get(key) {
    return decode(await this.client.get(key));
  }

  async set(key, value, options = {}) {
    const ttl = Number(options.ttlMs);
    const opts = Number.isFinite(ttl) && ttl > 0 ? { px: Math.max(1, Math.floor(ttl)) } : {};
    await this.client.set(key, JSON.stringify(value), opts);
  }

  async delete(key) {
    await this.client.del(key);
  }

  async acquireLease(name, ttlMs) {
    const token = randomBytes(16).toString("hex");
    const result = await this.client.set(name, token, { nx: true, px: leaseTtl(ttlMs) });
    return result === "OK" || result === true ? token : null;
  }

  async releaseLease(name, token) {
    if (!token) return;
    if (typeof this.client.eval === "function") {
      try {
        await this.client.eval(RELEASE_SCRIPT, [name], [token]);
        return;
      } catch {
        // Fall through to the guarded delete below.
      }
    }
    const current = await this.client.get(name);
    if (current === token) await this.client.del(name);
  }

  async incrementWindow(key, windowMs) {
    const ttl = Number(windowMs);
    const ms = Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 60_000;
    if (typeof this.client.eval === "function") {
      try {
        const count = await this.client.eval(INCREMENT_SCRIPT, [key], [ms]);
        return Number(count);
      } catch {
        // Fall through to non-atomic best effort.
      }
    }
    const count = Number(await this.client.incr(key));
    if (count === 1 && typeof this.client.pexpire === "function") {
      await this.client.pexpire(key, ms);
    }
    return count;
  }

  async withLock(name, ttlMs, fn) {
    const ttl = leaseTtl(ttlMs);
    const deadline = Date.now() + 500;
    let token = null;
    while (!token && Date.now() <= deadline) {
      token = await this.acquireLease(name, ttl);
      if (!token) await delay(10 + Math.floor(Math.random() * 15));
    }
    if (!token) throw new ConflictError("This run is busy. Try again.");
    try {
      return await fn();
    } finally {
      await this.releaseLease(name, token);
    }
  }
}
