import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { ConflictError } from "../errors.js";

const DEFAULT_LEASE_TTL_MS = 30_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeKey(key) {
  return Buffer.from(String(key), "utf8").toString("base64url");
}

function leaseTtl(ttlMs) {
  const parsed = Number(ttlMs);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_LEASE_TTL_MS;
}

/**
 * JSON-file store. Writes are atomic (temp file + rename), TTL is enforced on
 * read, and every mutation of a key is serialized through a per-key queue so a
 * single process can use it safely from concurrent async code.
 */
export class FileStore {
  /** @param {{ fileDir?: string }} [config] */
  constructor(config = {}) {
    this.dir = config.fileDir || path.join(process.cwd(), ".falsegreen-data");
    /** @type {Map<string, Promise<void>>} */
    this.queues = new Map();
  }

  #file(key) {
    return path.join(this.dir, `${encodeKey(key)}.json`);
  }

  #lockFile(key) {
    return path.join(this.dir, `${encodeKey(key)}.lock`);
  }

  async #exclusive(key, fn) {
    const previous = this.queues.get(key) || Promise.resolve();
    const result = previous.then(fn, fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, tail);
    tail.finally(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return result;
  }

  async #ensureDir() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async #writeAtomic(file, data) {
    await this.#ensureDir();
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  }

  async #readRecord(file) {
    try {
      const raw = await fs.readFile(file, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      return null;
    }
  }

  async #remove(file) {
    try {
      await fs.unlink(file);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }

  async get(key) {
    const file = this.#file(key);
    const record = await this.#readRecord(file);
    if (!record) return null;
    if (record.__expiresAt != null && Date.now() >= Number(record.__expiresAt)) {
      await this.#remove(file);
      return null;
    }
    return record.value ?? null;
  }

  async set(key, value, options = {}) {
    const ttl = Number(options.ttlMs);
    const record = { value };
    if (Number.isFinite(ttl) && ttl > 0) record.__expiresAt = Date.now() + Math.floor(ttl);
    await this.#exclusive(key, () => this.#writeAtomic(this.#file(key), JSON.stringify(record)));
  }

  async delete(key) {
    await this.#exclusive(key, () => this.#remove(this.#file(key)));
  }

  async acquireLease(name, ttlMs) {
    return this.#exclusive(name, async () => {
      const file = this.#lockFile(name);
      const token = randomBytes(16).toString("hex");
      const expiresAt = Date.now() + leaseTtl(ttlMs);
      await this.#ensureDir();

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const handle = await fs.open(file, "wx");
          try {
            await handle.writeFile(JSON.stringify({ token, expiresAt }), "utf8");
            await handle.sync();
          } finally {
            await handle.close();
          }
          return token;
        } catch (error) {
          if (!error || error.code !== "EEXIST") throw error;
        }

        const existing = await this.#readRecord(file);
        if (existing && Number(existing.expiresAt) > Date.now()) return null;

        const stale = `${file}.stale.${token}.${attempt}`;
        try {
          await fs.rename(file, stale);
          await this.#remove(stale);
        } catch (error) {
          if (error && error.code === "ENOENT") continue;
          throw error;
        }
      }
      return null;
    });
  }

  async releaseLease(name, token) {
    if (!token) return;
    await this.#exclusive(name, async () => {
      const file = this.#lockFile(name);
      const existing = await this.#readRecord(file);
      if (existing && existing.token === token) await this.#remove(file);
    });
  }

  async incrementWindow(key, windowMs) {
    const ttl = Number(windowMs);
    const seconds = Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 0;
    return this.#exclusive(key, async () => {
      const file = this.#file(key);
      const now = Date.now();
      const record = await this.#readRecord(file);
      const live = record && (record.__expiresAt == null || Number(record.__expiresAt) > now);
      const count = live ? Number(record.value) || 0 : 0;
      const next = count + 1;
      const expiresAt = live && record.__expiresAt != null ? Number(record.__expiresAt) : now + seconds;
      await this.#writeAtomic(file, JSON.stringify({ value: next, __expiresAt: expiresAt }));
      return next;
    });
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
