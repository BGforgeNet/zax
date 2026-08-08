/**
 * Recovers the previous UI's tab and frame grouping from its layout modules.
 *
 * Frames matter: labels like "Art", "Orientation" and "Width" were written to be read inside a
 * frame("Interface bar", ...) and are meaningless without it. Depth tracking is required because a frame's
 * name can sit on the line after `frame(`, and because a setting following a closed frame belongs to no frame.
 */
import fs from "node:fs";

const MODULES = { ddraw_ini: "ddraw.ini", f2_res_ini: "f2_res.ini", fallout2_cfg: "fallout2.cfg" };
const CALL = /\b(checkbox|dropdown|radio|slider|spin|qinput)\(\s*c\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"/;
const DIRECT = /key="([^"]+\.(?:ini|cfg))-([^"-]+)-([^"]+)"/;

const out = [];

for (const [mod, file] of Object.entries(MODULES)) {
  const lines = fs.readFileSync(`scripts/gen/py/${mod}.py`, "utf8").split("\n");
  let depth = 0;
  let tab = null;
  /** Stack of {name, depth} so nested frames pop in the right order. */
  const frames = [];
  let pendingFrame = false;
  /** Depth outside the frame's own parenthesis, so the frame stays open while depth exceeds it. */
  let pendingDepth = 0;
  let order = 0;

  for (const line of lines) {
    const tabStart = line.match(/^tabs\["([^"]+)"\]/);
    if (tabStart) {
      tab = tabStart[1];
      frames.length = 0;
      depth = 0;
    }

    // A frame's name is either on the frame( line or the next non-blank one.
    if (pendingFrame) {
      const name = line.match(/^\s*"([^"]+)"\s*,?\s*$/);
      if (name) {
        frames.push({ name: name[1], depth: pendingDepth });
        pendingFrame = false;
      }
    }
    const inlineFrame = line.match(/\bframe\(\s*"([^"]+)"/);
    const bareFrame = /\bframe\(\s*$/.test(line);

    const call = CALL.exec(line);
    const direct = DIRECT.exec(line);
    if (tab && (call || direct)) {
      const [section, key] = call ? [call[2], call[3]] : [direct[2], direct[3]];
      out.push({
        file,
        tab,
        frame: frames.length ? frames[frames.length - 1].name : null,
        section,
        key,
        widget: call ? call[1] : "custom",
        order: order++,
      });
    }

    if (inlineFrame) frames.push({ name: inlineFrame[1], depth });
    else if (bareFrame) {
      pendingFrame = true;
      pendingDepth = depth;
    }

    depth += (line.match(/[([]/g) ?? []).length - (line.match(/[)\]]/g) ?? []).length;
    while (frames.length && depth <= frames[frames.length - 1].depth) frames.pop();
  }
}

fs.writeFileSync("scripts/gen/layout.json", JSON.stringify(out, null, 1));

console.log(`settings: ${out.length}, with a frame: ${out.filter((r) => r.frame).length}`);
const byFrame = {};
for (const r of out) (byFrame[`${r.file} > ${r.tab} > ${r.frame ?? "-"}`] ??= []).push(r.key);
for (const [k, v] of Object.entries(byFrame)) console.log(`${k.padEnd(54)} ${String(v.length).padStart(3)}`);
