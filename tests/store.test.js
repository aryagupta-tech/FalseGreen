import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStore, FileStore, RedisStore } from "../src/core/store/index.js";
import { ConflictError } from "../src/core/errors.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let dirs = [];

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-store-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})),
  );
  dirs = [];
});

class FakeRedis {
  constructor() {
    this.data = new Map();
  }

  #purge(key) {
    const entry = this.data.get(key);
    if (entry && entry.expiresAt != null && entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return null;
    }
    return entry || null;
  }

  async get(key) {
    const entry = this.#purge(key);
    return entry ? entry.value : null;
  }

  async set(key, value, options = {}) {
    const existing = this.#purge(key);
    if ((options.nx || options.NX) && existing) return null;
    this.data.set(key, {
      value,
      expiresAt: options.px || options.PX ? Date.now() + Number(options.px || options.PX) : null,
    });
    return "OK";
  }

  async del(key) {
    const existed = this.data.delete(key);
    return existed ? 1 : 0;
  }

  async incr(key) {
    const entry = this.#purge(key);
    const next = (Number(entry?.value) || 0) + 1;
    this.data.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
    return next;
  }

  async pexpire(key, ms) {
    const entry = this.#purge(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + Number(ms);
    return 1;
  }

  async pttl(key) {
    const entry = this.#purge(key);
    if (!entry) return -2;
    if (entry.expiresAt == null) return -1;
    return entry.expiresAt - Date.now();
  }

  async eval(script, keys, args) {
    const key = keys[0];
    if (script.includes("'incr'")) {
      const count = await this.incr(key);
      const ttl = await this.pttl(key);
      if (ttl < 0) await this.pexpire(key, Number(args[0]));
      return count;
    }
    if (script.includes("redis.call(\"del\"")) {
      const current = await this.get(key);
      if (current === args[0]) {
        await this.del(key);
        return 1;
      }
      return 0;
    }
    throw new Error("Unsupported script");
  }
}

describe("FileStore", () => {
  let dir;
  let store;

  beforeEach(async () => {
    dir = await tempDir();
    store = new FileStore({ fileDir: dir });
  });

  it("stores and deletes JSON values", async () => {
    await store.set("fg:run:a", { id: "a", nested: { ok: true } });
    expect(await store.get("fg:run:a")).toEqual({ id: "a", nested: { ok: true } });
    await store.delete("fg:run:a");
    expect(await store.get("fg:run:a")).toBe(null);
    expect(await store.get("fg:run:missing")).toBe(null);
  });

  it("enforces TTL on read", async () => {
    await store.set("fg:run:ttl", { value: 1 }, { ttlMs: 40 });
    expect(await store.get("fg:run:ttl")).toEqual({ value: 1 });
    await sleep(70);
    expect(await store.get("fg:run:ttl")).toBe(null);
  });

  it("acquires, guards, and releases leases", async () => {
    const token = await store.acquireLease("fg:lease:job:0", 5000);
    expect(token).toBeTruthy();
    expect(await store.acquireLease("fg:lease:job:0", 5000)).toBe(null);

    await store.releaseLease("fg:lease:job:0", "not-the-token");
    expect(await store.acquireLease("fg:lease:job:0", 5000)).toBe(null);

    await store.releaseLease("fg:lease:job:0", token);
    const next = await store.acquireLease("fg:lease:job:0", 5000);
    expect(next).toBeTruthy();
    expect(next).not.toBe(token);
  });

  it("reclaims a stale lock file", async () => {
    const first = await store.acquireLease("fg:lease:job:1", 20);
    expect(first).toBeTruthy();
    await sleep(60);
    const second = await store.acquireLease("fg:lease:job:1", 5000);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it("serializes concurrent work through withLock", async () => {
    let active = 0;
    let maxActive = 0;
    let completed = 0;

    await Promise.all(
      Array.from({ length: 5 }, () =>
        store.withLock("fg:lock:run:a", 5000, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(15);
          completed += 1;
          active -= 1;
        }),
      ),
    );

    expect(maxActive).toBe(1);
    expect(completed).toBe(5);
  });

  it("rejects withLock when the lock stays held", async () => {
    const token = await store.acquireLease("fg:lock:run:busy", 5000);
    await expect(
      store.withLock("fg:lock:run:busy", 5000, async () => "never"),
    ).rejects.toBeInstanceOf(ConflictError);
    await store.releaseLease("fg:lock:run:busy", token);
  });

  it("increments a window atomically and expires it", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.incrementWindow("fg:rate:s1", 5000)),
    );
    expect([...results].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect(await store.get("fg:rate:s1")).toBe(20);

    expect(await store.incrementWindow("fg:rate:s2", 40)).toBe(1);
    await sleep(70);
    expect(await store.incrementWindow("fg:rate:s2", 40)).toBe(1);
  });
});

describe("RedisStore", () => {
  let client;
  let store;

  beforeEach(() => {
    client = new FakeRedis();
    store = new RedisStore(
      { redisUrl: "https://example.invalid", redisToken: "test-token" },
      { client },
    );
  });

  it("stores, expires, and deletes JSON values", async () => {
    await store.set("fg:run:a", { id: "a", ok: true });
    expect(await store.get("fg:run:a")).toEqual({ id: "a", ok: true });

    await store.set("fg:run:ttl", { id: "ttl" }, { ttlMs: 30 });
    await sleep(50);
    expect(await store.get("fg:run:ttl")).toBe(null);

    await store.delete("fg:run:a");
    expect(await store.get("fg:run:a")).toBe(null);
  });

  it("uses SET NX PX leases and compare-and-delete release", async () => {
    const token = await store.acquireLease("fg:lease:job:0", 5000);
    expect(token).toBeTruthy();
    expect(await store.acquireLease("fg:lease:job:0", 5000)).toBe(null);

    await store.releaseLease("fg:lease:job:0", "wrong");
    expect(await store.acquireLease("fg:lease:job:0", 5000)).toBe(null);

    await store.releaseLease("fg:lease:job:0", token);
    expect(await store.acquireLease("fg:lease:job:0", 5000)).toBeTruthy();
  });

  it("increments a window and keeps its expiry", async () => {
    const first = await store.incrementWindow("fg:rate:s1", 5000);
    const second = await store.incrementWindow("fg:rate:s1", 5000);
    expect([first, second]).toEqual([1, 2]);
    const clientEntry = await client.get("fg:rate:s1");
    expect(clientEntry).toBe("2");
  });

  it("serializes withLock callers", async () => {
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        store.withLock("fg:lock:run:r", 5000, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(10);
          active -= 1;
        }),
      ),
    );
    expect(maxActive).toBe(1);
  });
});

describe("createStore", () => {
  it("selects the file driver by default and by name", async () => {
    const dir = await tempDir();
    const file = createStore({ store: { driver: "file", fileDir: dir } });
    expect(file).toBeInstanceOf(FileStore);
    const implicit = createStore({ store: { fileDir: dir } });
    expect(implicit).toBeInstanceOf(FileStore);
  });

  it("selects the redis driver", () => {
    const redis = createStore({
      store: { driver: "redis", redisUrl: "https://example.invalid", redisToken: "token" },
    });
    expect(redis).toBeInstanceOf(RedisStore);
  });
});
