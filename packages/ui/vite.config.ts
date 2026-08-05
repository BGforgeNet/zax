import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

// Fixtures live at the workspace root; the preview reads them directly rather than keeping a second copy.
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  // Relative asset URLs: the desktop build loads index.html from a file, where a root-absolute "/assets/..."
  // resolves against the filesystem root rather than against the page.
  base: "./",
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
