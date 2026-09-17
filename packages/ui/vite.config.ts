import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Fixtures live at the workspace root; the preview reads them directly rather than keeping a second copy.
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The commit a build came from, or "" for a build made from a release tag.
 *
 * Everything but a tagged release reports the commit instead of the version: a build from a checkout carries
 * the manifest's version, which names a release that does not contain it, so a bug report against "0.8.0" could
 * be any of the commits between one release and the next. Empty when git cannot answer - an unpacked source
 * archive has no repository - which falls back to the version rather than showing nothing.
 */
function buildCommit(): string {
  if (process.env.GITHUB_REF_TYPE === "tag") return "";
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

// No content security policy here: the shell sets it (`crates/shell/tauri.conf.json`), as a header Tauri adds
// its own script hashes to. A meta tag would be a second policy on top, and every request has to pass both - so
// one without the shell's `connect-src ipc:` would push every command off Tauri's IPC protocol. The policy denies
// everything but the bundle itself; styles stay inline-permitted because Svelte injects them at runtime.
export default defineConfig({
  // Empty on a release build, which is the only kind whose version number names something a user can download.
  define: { __ZAX_COMMIT__: JSON.stringify(buildCommit()) },
  plugins: [svelte()],
  // HOST and PORT are read from the environment so a machine that needs a specific bind address or port can
  // say so without editing this file.
  server: {
    host: process.env.HOST ?? "localhost",
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
    fs: { allow: [workspaceRoot] },
  },
});
