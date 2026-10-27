import Playground from "@/components/Playground";
import { loadConfig } from "@/core/config";
import { DEFAULT_PRESET_ID, PRESETS, getPreset } from "@/lib/presets";

export const dynamic = "force-dynamic";

export default function Page() {
  const { publicConfig } = loadConfig();

  return (
    <Playground
      initialPreset={getPreset(DEFAULT_PRESET_ID)}
      presets={PRESETS}
      publicConfig={publicConfig}
    />
  );
}
