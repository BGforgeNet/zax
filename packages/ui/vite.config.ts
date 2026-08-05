import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

// Fixtures live at the workspace root; the preview reads them directly rather than keeping a second copy.
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
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
