import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import ts from "typescript-eslint";
import svelte from "eslint-plugin-svelte";
import globals from "globals";

// oxlint owns every .js/.ts file, and the <script> block of every component along with them. What it cannot read
// is the template half of a .svelte file - no oxc tool lints Svelte templates - so eslint stays for that surface
// and nothing else. The overlap inside a script block is small and both linters agree on it; what only eslint
// reaches is the svelte/* set, plus unused variables in a component - oxlint declines to report those, having no
// view of the template that would use them.
export default defineConfig(globalIgnores(["**/dist/", ".work/", "coverage/", "scripts/gen/formats/"]), {
  files: ["**/*.svelte", "**/*.svelte.ts"],
  extends: [js.configs.recommended, ts.configs.recommended, svelte.configs.recommended],
  languageOptions: {
    globals: { ...globals.node, ...globals.browser },
    parserOptions: { parser: ts.parser, extraFileExtensions: [".svelte"] },
  },
  rules: {
    // A leading underscore is the discard marker - the rest-destructure that drops a key reads better than
    // a delete on a reactive object.
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
  },
});
