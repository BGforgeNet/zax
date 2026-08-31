import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

// oxfmt formats .svelte only when `svelte` is on in .oxfmtrc.json and the svelte package resolves. With either
// missing it does not report those files, it stops seeing them: the run exits 0 having read none of the
// components, and `pnpm lint` is green over whatever they contain. Nothing else here would notice, so this
// drives the real binary at a component it has to reformat.
test("the formatter reads .svelte files rather than silently skipping them", () => {
  const dir = mkdtempSync(join(tmpdir(), "zax-format-"));
  try {
    const probe = join(dir, "Probe.svelte");
    writeFileSync(probe, '<script lang="ts">\nlet count = 0;\n</script>\n\n<button>{count}</button>\n');
    // Through the runtime running this test rather than a PATH lookup, and with the repo's own config, which is
    // the thing under test - config discovery would not reach it from a directory outside the repo.
    const run = spawnSync(process.execPath, ["node_modules/oxfmt/bin/oxfmt", "--check", "-c", ".oxfmtrc.json", probe], {
      encoding: "utf8",
      timeout: 30_000,
    });

    // 1 is "this file is not formatted"; 2 is "no file matched", which is what a skipped .svelte looks like.
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("Probe.svelte");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
