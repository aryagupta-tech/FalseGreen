import { loadConfig } from "../core/config.js";
import { createStore } from "../core/store/index.js";

let storeInstance = null;
let storeSignature = "";

/**
 * One store per server process. The signature only changes during development
 * when the driver or data directory changes, so a restart is not required.
 *
 * @param {ReturnType<typeof loadConfig>} [config]
 */
export function getStore(config = loadConfig()) {
  const signature = `${config.store.driver}:${config.store.redisUrl}:${config.store.fileDir}`;
  if (!storeInstance || signature !== storeSignature) {
    storeInstance = createStore(config);
    storeSignature = signature;
  }
  return storeInstance;
}

export function getRuntime() {
  const config = loadConfig();
  return { config, store: getStore(config) };
}
