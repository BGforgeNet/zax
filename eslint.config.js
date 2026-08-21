import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import ts from "typescript-eslint";
import svelte from "eslint-plugin-svelte";
import globals from "globals";

export default defineConfig(
  globalIgnores(["**/dist/", ".work/", "coverage/", "scripts/gen/formats/"]),
  js.configs.recommended,
  ts.configs.recommended,
  svelte.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      // A leading underscore is the discard marker - the rest-destructure that drops a key reads better than
      // a delete on a reactive object.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // CommonJS by design: the extraction worker is loaded by path, outside any bundle.
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // Type-aware rules for plain TypeScript only; Svelte files stay on the syntactic rule set, which keeps the
    // first-run surface manageable while still catching the async mistakes the domain code can actually make.
    files: ["**/*.ts"],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: { parserOptions: { parser: ts.parser, extraFileExtensions: [".svelte"] } },
  },
);
