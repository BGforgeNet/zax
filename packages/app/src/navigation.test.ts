import { describe, expect, it } from "vitest";
import { isOwnContent, isWebUrl } from "./navigation.js";

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
  it("allows the built files when no dev server is given", () => {
    expect(isOwnContent("file:///opt/zax/renderer/index.html", undefined)).toBe(true);
    expect(isOwnContent("file:///opt/zax/renderer/index.html", "")).toBe(true);
  });

  it("refuses a web page when no dev server is given, however local it looks", () => {
    expect(isOwnContent("https://bgforge.net/", undefined)).toBe(false);
    expect(isOwnContent("http://localhost:5173/", undefined)).toBe(false);
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
    expect(isOwnContent("file:///opt/zax/renderer/index.html", dev)).toBe(false);
  });

  it("refuses what is not a URL at all rather than throwing on it", () => {
    expect(isOwnContent("not a url", undefined)).toBe(false);
    expect(isOwnContent("not a url", "http://localhost:5173")).toBe(false);
  });
});
