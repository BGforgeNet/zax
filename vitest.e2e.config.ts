import { defineConfig } from "vitest/config";

// The drive of the built application, kept out of `pnpm test`: it needs a release build, tauri-driver and the
// platform's native WebDriver, none of which the interface's suite does.
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    // A cold webview and a real disk; the hooks start the driver and the application, so they get the same room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
