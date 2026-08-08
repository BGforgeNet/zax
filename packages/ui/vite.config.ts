import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

// Fixtures live at the workspace root; the preview reads them directly rather than keeping a second copy.
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

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
