import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  // The store is a `.svelte.ts` rune module, so testing it needs the same compilation the app gets - without
  // the plugin its `$state` declarations stay plain calls and the module will not load.
  plugins: [svelte({ configFile: "packages/ui/svelte.config.js" })],
  resolve: { conditions: ["browser"] },
  test: { include: ["packages/*/src/**/*.test.ts"] },
});
