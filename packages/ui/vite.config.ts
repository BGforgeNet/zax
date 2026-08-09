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

/**
 * The interface loads its own bundle and reaches the machine over the preload bridge, never the network, so
 * everything else is denied. Styles stay inline-permitted because Svelte injects them at runtime; scripts do
 * not, which is the half that turns injected markup into code.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Build only: the dev server needs inline scripts and a websocket to reload, and widening the policy far enough
 * to admit those would carry the slack into the shipped application.
 */
const contentSecurityPolicy = {
  name: "zax-content-security-policy",
  apply: "build",
  transformIndexHtml: () => [
    {
      tag: "meta",
      attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY },
      injectTo: "head-prepend",
    },
  ],
} as const;

export default defineConfig({
  // Relative asset URLs: the desktop build loads index.html from a file, where a root-absolute "/assets/..."
  // resolves against the filesystem root rather than against the page.
  base: "./",
  // Empty on a release build, which is the only kind whose version number names something a user can download.
  define: { __ZAX_COMMIT__: JSON.stringify(buildCommit()) },
  plugins: [svelte(), contentSecurityPolicy],
  // HOST and PORT are read from the environment so a machine that needs a specific bind address or port can
  // say so without editing this file.
  server: {
    host: process.env.HOST ?? "localhost",
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
    fs: { allow: [workspaceRoot] },
  },
});
