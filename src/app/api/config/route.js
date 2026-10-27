import { loadConfig } from "../../../core/config.js";
import { PRESETS } from "../../../lib/presets.js";
import { handleApi, json } from "../../../lib/http.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = handleApi(async () => {
  const { publicConfig } = loadConfig();
  return json({ config: publicConfig, presets: PRESETS });
});
