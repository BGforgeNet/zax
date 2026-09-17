import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  // The store is a `.svelte.ts` rune module, so testing it needs the same compilation the app gets - without
  // the plugin its `$state` declarations stay plain calls and the module will not load.
  plugins: [svelte({ configFile: "packages/ui/svelte.config.js" })],
  resolve: { conditions: ["browser"] },
  test: {
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.ts"],
    // The preview's WebAssembly, loaded from disk before the interface's tests import it - see the file.
    setupFiles: ["packages/ui/vitest.setup.ts"],
    coverage: {
      provider: "v8",
      // Text for the run's own output, and the lcov data on its own for anything that reads it afterwards.
      // Both `lcov` and the default set also write an HTML site of their own, which nothing here looks at.
      //
      // The text table omits a file that is at 100% on all four metrics, so a module missing from it is fully
      // covered rather than unmeasured - `coverage/lcov.info` lists every file either way and is what to read
      // before concluding anything about one that is not printed.
      reporter: ["text", "lcovonly"],
      // Named rather than left to default: without it the ratio is taken over whatever the run happened to
      // load, so adding a dependency moves the number without anything about this code changing.
      include: ["packages/*/src/**/*.ts", "packages/*/src/**/*.svelte"],
      exclude: [
        "**/*.test.ts",
        // The component tests' own setup - the preview disk reseeded and a component mounted against it. Test
        // support rather than shipped code, and counting it would report on the harness, not the interface.
        "packages/ui/src/lib/preview-fixture.ts",
        // The entry point: it mounts the root component and holds no decision of its own.
        "packages/ui/src/main.ts",
      ],
      // A floor that only rises, set a point or so below what the suite currently reaches so ordinary movement
      // does not trip it. It is here to make an untested path visible, not to be aimed at: pinning it to
      // whatever the last run scored turns every unrelated change into a coverage failure.
      thresholds: { statements: 93, branches: 85, functions: 92, lines: 95 },
    },
  },
});
