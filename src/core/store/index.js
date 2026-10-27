import { ConfigError } from "../errors.js";
import { FileStore } from "./file-store.js";
import { RedisStore } from "./redis-store.js";

export { FileStore } from "./file-store.js";
export { RedisStore } from "./redis-store.js";

/**
 * @param {{ store?: { driver?: string, fileDir?: string, redisUrl?: string, redisToken?: string }, driver?: string, fileDir?: string, redisUrl?: string, redisToken?: string }} config
 * @param {{ client?: unknown }} [options]
 * @returns {FileStore | RedisStore}
 */
export function createStore(config = {}, options = {}) {
  const storeConfig = config.store || config;
  const driver = storeConfig.driver || "file";
  if (driver === "file") return new FileStore(storeConfig);
  if (driver === "redis") return new RedisStore(storeConfig, options);
  throw new ConfigError(`Unknown store driver: ${driver}`);
}
