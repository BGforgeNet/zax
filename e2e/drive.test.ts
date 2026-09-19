// The built application driven through WebDriver: the real shell, its webview and the machine's own files, which
// the interface's suite reaches only through the in-memory preview. tauri-driver fronts the platform's native
// driver - WebKitWebDriver on Linux, the Edge driver matching WebView2 on Windows - and neither exists on macOS.
//
// The protocol is spoken over `fetch` rather than through a client library: the handful of calls below is all
// this needs, and a client would be a dependency tree for them.

import { type ChildProcess, spawn } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const PROGRAM = process.platform === "win32" ? "zax.exe" : "zax";
const DRIVER = "http://127.0.0.1:4444";
/** WebDriver's key for an element reference in an answer. */
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

let driver: ChildProcess | undefined;
let session = "";
let scratch = "";
let game = "";

async function call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(
    `${DRIVER}${path}`,
    body === undefined
      ? { method }
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const answer = (await response.json()) as { value: unknown };
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${JSON.stringify(answer.value)}`);
  return answer.value;
}

/** Polls until `probe` answers something other than undefined, failing with what it was waiting for. */
async function until<T>(what: string, probe: () => Promise<T | undefined>, seconds = 30): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  // The last refusal, so a wait that never settles says what it kept running into.
  let last = "";
  while (Date.now() < deadline) {
    try {
      const held = await probe();
      if (held !== undefined) return held;
    } catch (error) {
      last = error instanceof Error ? error.message : JSON.stringify(error);
    }
    await new Promise((settle) => setTimeout(settle, 250));
  }
  throw new Error(`Gave up waiting for ${what} after ${seconds}s${last ? `: ${last}` : ""}`);
}

async function find(using: "css selector" | "xpath", value: string): Promise<string> {
  const found = (await call("POST", `/session/${session}/element`, { using, value })) as Record<string, string>;
  const id = found[ELEMENT];
  if (id === undefined) throw new Error(`No element reference in the answer for ${value}`);
  return id;
}

async function attribute(element: string, name: string): Promise<unknown> {
  return call("GET", `/session/${session}/element/${element}/attribute/${name}`);
}

async function click(element: string): Promise<void> {
  await call("POST", `/session/${session}/element/${element}/click`, {});
}

beforeAll(async () => {
  // A portable copy: the program with a `data` directory beside it, so the run reads and writes nowhere but here.
  scratch = mkdtempSync(join(tmpdir(), "zax-drive-"));
  const copy = join(scratch, "ZAX");
  mkdirSync(join(copy, "data", "config"), { recursive: true });
  copyFileSync(join(ROOT, "target", "release", PROGRAM), join(copy, PROGRAM));

  // Real configuration files, and the executable an install is recognised by, which is never read.
  game = join(scratch, "game");
  cpSync(join(ROOT, "fixtures", "f2up"), game, { recursive: true });
  writeFileSync(join(game, "fallout2.exe"), "");
  // Single-quoted, so a Windows path's backslashes are characters rather than escapes.
  writeFileSync(join(copy, "data", "config", "zax.yml"), `games:\n  - path: '${game.replaceAll("'", "''")}'\n`);

  driver = spawn(process.env.TAURI_DRIVER ?? "tauri-driver", [], { stdio: ["ignore", "inherit", "inherit"] });
  await until("tauri-driver to listen", async () => ((await call("GET", "/status")) === undefined ? undefined : true));

  const opened = (await call("POST", "/session", {
    capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: join(copy, PROGRAM) } } },
  })) as { sessionId: string };
  session = opened.sessionId;
}, 120_000);

afterAll(async () => {
  try {
    if (session) await call("DELETE", `/session/${session}`);
  } finally {
    driver?.kill();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
});

test("a setting changed in the window is written to the game's file as that one line", async () => {
  const path = join(game, "fallout2.cfg");
  const before = readFileSync(path, "latin1");
  // Once exactly, so the replace below names the one line the save may touch.
  expect(before.split("running=0")).toHaveLength(2);

  // The install is the only one listed, so it opens on its settings - and a fresh copy saves as it goes, so the
  // edit alone is what writes the file.
  const toggle = await until("the Always run switch", async () =>
    find("css selector", '[role="switch"][aria-label="Always run"]'),
  );
  await find("xpath", '//span[normalize-space()="Saved automatically"]');
  expect(await attribute(toggle, "aria-checked")).toBe("false");
  await click(toggle);
  await until("the switch to turn on", async () =>
    (await attribute(toggle, "aria-checked")) === "true" ? true : undefined,
  );

  const after = await until("the file to change", async () => {
    const now = readFileSync(path, "latin1");
    return now === before ? undefined : now;
  });

  // Every other byte where it was: one key rewritten, comments, order and line endings untouched.
  expect(after).toBe(before.replace("running=0", "running=1"));
}, 120_000);
