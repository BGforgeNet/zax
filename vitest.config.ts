import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  // The store is a `.svelte.ts` rune module, so testing it needs the same compilation the app gets - without
  // the plugin its `$state` declarations stay plain calls and the module will not load.
  plugins: [svelte({ configFile: "packages/ui/svelte.config.js" })],
  resolve: { conditions: ["browser"] },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Text for the run's own output, and the lcov data on its own for anything that reads it afterwards.
      // Both `lcov` and the default set also write an HTML site of their own, which nothing here looks at.
      reporter: ["text", "lcovonly"],
      // Named rather than left to default: without it the ratio is taken over whatever the run happened to
      // load, so adding a dependency moves the number without anything about this code changing.
      include: ["packages/*/src/**/*.ts", "packages/*/src/**/*.svelte"],
      exclude: [
        "**/*.test.ts",
        // The component tests' own setup - the preview disk reseeded and a component mounted against it. Test
        // support rather than shipped code, and counting it would report on the harness, not the interface.
        "packages/ui/src/lib/preview-fixture.ts",
        // Generated data tables. They are one long literal each, counted as executed the moment they are
        // imported, and eleven hundred such lines swamp the ratio for the code that has branches in it.
        "packages/games-fallout2/src/catalog.ts",
        "packages/games-fallout2/src/layout.ts",
        // The three process entry points. Each one constructs the window, the bridge or the root component and
        // holds no decision of its own - every decision that was in them lives in `dispatch`, `navigation` and
        // `ipc-error`, which are covered. Measuring them would only report that Electron is not loaded here.
        "packages/app/src/main.ts",
        "packages/app/src/preload.ts",
        "packages/ui/src/main.ts",
      ],
      // A floor that only rises, set below what the suite currently reaches so ordinary movement does not trip
      // it. It is here to make an untested path visible, not to be aimed at: raising it to whatever the last
      // run scored turns every unrelated change into a coverage failure.
      thresholds: { statements: 88, branches: 82, functions: 88, lines: 90 },
    },
  },
});
