import { describe, expect, it } from "vitest";
import { isOwnContent, isTrustedIpcSender, isWebUrl } from "./navigation.js";

/*
  These two decide what the shell hands to the desktop and where a window with the preload bridge attached is
  allowed to go, so they are covered the way the channel's allowlist is - here, with no Electron in the room.
*/
describe("what may be handed to the desktop's own handler", () => {
  it("passes the two schemes a link can legitimately carry", () => {
    expect(isWebUrl("https://bgforge.net/")).toBe(true);
    expect(isWebUrl("http://localhost:5173/")).toBe(true);
  });

  it("refuses a file path, which is how an open becomes an execution", () => {
    expect(isWebUrl("file:///etc/passwd")).toBe(false);
    expect(isWebUrl("file://C:/Windows/System32/cmd.exe")).toBe(false);
  });

  it("refuses a registered protocol, which resolves to whatever claimed it", () => {
    expect(isWebUrl("steam://run/38400")).toBe(false);
    expect(isWebUrl("javascript:alert(1)")).toBe(false);
    expect(isWebUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("refuses what is not a URL at all rather than throwing on it", () => {
    expect(isWebUrl("")).toBe(false);
    expect(isWebUrl("not a url")).toBe(false);
    expect(isWebUrl("/games/one")).toBe(false);
  });
});

describe("where the window may navigate", () => {
  const packaged = "file:///opt/zax/renderer/index.html";

  it("allows only the packaged entry point and its fragment", () => {
    expect(isOwnContent(packaged, packaged)).toBe(true);
    expect(isOwnContent(`${packaged}#settings`, packaged)).toBe(true);
  });

  it("refuses every other file even when it sits beside the renderer", () => {
    expect(isOwnContent("file:///opt/zax/renderer/other.html", packaged)).toBe(false);
    expect(isOwnContent("file:///tmp/index.html", packaged)).toBe(false);
  });

  it("refuses a web page when the application entry is packaged, however local it looks", () => {
    expect(isOwnContent("https://bgforge.net/", packaged)).toBe(false);
    expect(isOwnContent("http://localhost:5173/", packaged)).toBe(false);
  });

  it("allows the dev server's own origin when one is given", () => {
    const dev = "http://localhost:5173";
    expect(isOwnContent("http://localhost:5173/", dev)).toBe(true);
    expect(isOwnContent("http://localhost:5173/src/main.ts", dev)).toBe(true);
  });

  it("refuses another origin while a dev server is given, port and host alike", () => {
    const dev = "http://localhost:5173";
    expect(isOwnContent("http://localhost:5174/", dev)).toBe(false);
    expect(isOwnContent("http://evil.example/", dev)).toBe(false);
    // The file scheme is not its own content in this mode - which is the half a single check would miss.
    expect(isOwnContent(packaged, dev)).toBe(false);
  });

  it("refuses what is not a URL at all rather than throwing on it", () => {
    expect(isOwnContent("not a url", packaged)).toBe(false);
    expect(isOwnContent("not a url", "http://localhost:5173")).toBe(false);
  });
});

describe("who may use the privileged channel", () => {
  const own = "file:///opt/zax/renderer/index.html";

  it("accepts the application's main frame", () => {
    const frame = { url: own };
    expect(isTrustedIpcSender(frame, frame, own)).toBe(true);
  });

  it("refuses a missing frame, a subframe, and another local file", () => {
    const main = { url: own };
    expect(isTrustedIpcSender(null, main, own)).toBe(false);
    expect(isTrustedIpcSender({ url: own }, main, own)).toBe(false);
    const other = { url: "file:///tmp/untrusted.html" };
    expect(isTrustedIpcSender(other, other, own)).toBe(false);
  });
});
