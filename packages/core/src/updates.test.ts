import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import { latestZax } from "./updates.js";
import type { OperatingSystem } from "@zax/platform";

const URL = "https://api.github.com/repos/BGforgeNet/zax/releases/latest";

/** The shape GitHub returns, cut down to the fields that are read. */
const FEED = JSON.stringify({
  tag_name: "v0.9",
  html_url: "https://github.com/BGforgeNet/zax/releases/tag/v0.9",
  assets: [
    { name: "zax.exe", browser_download_url: "https://example/zax.exe" },
    { name: "zax", browser_download_url: "https://example/zax" },
  ],
});

const feed = (os: OperatingSystem, body = FEED) => new MemoryPlatform({ os, responses: { [URL]: body } });

describe("checking for a newer ZAX", () => {
  it("reads the version from the release tag, without the tag's leading v", async () => {
    expect((await latestZax(feed("linux"))).version).toBe("0.9");
  });

  it("picks the build the machine asking can run", async () => {
    expect((await latestZax(feed("windows"))).url).toBe("https://example/zax.exe");
    expect((await latestZax(feed("linux"))).url).toBe("https://example/zax");
    expect((await latestZax(feed("macos"))).url).toBe("https://example/zax");
  });

  it("points at the release page when it publishes nothing for this machine", async () => {
    const body = JSON.stringify({ tag_name: "v0.9", html_url: "https://example/page", assets: [] });
    expect((await latestZax(feed("linux", body))).url).toBe("https://example/page");
  });

  it("reports a feed that names no version rather than presenting an empty one", async () => {
    await expect(latestZax(feed("linux", JSON.stringify({})))).rejects.toThrow(/did not name a version/);
  });

  it("lets a failed request through to the caller, which reports it", async () => {
    await expect(latestZax(new MemoryPlatform())).rejects.toThrow();
  });

  /*
    The address is handed to the system's own opener, which does whatever the scheme says. Everything below
    parses as a URL, so nothing here is caught by reading the feed - only by asking what the scheme is.
  */
  it.each([
    ["a scheme that reaches the disk", "file:///etc/passwd"],
    ["a scheme that runs script", "javascript:alert(1)"],
    ["an unencrypted address", "http://example/zax"],
    ["something that is not an address at all", "not a url"],
  ])("refuses %s in an asset, falling back to the release page", async (_what, url) => {
    const body = JSON.stringify({
      tag_name: "v0.9",
      html_url: "https://example/page",
      assets: [{ name: "zax", browser_download_url: url }],
    });
    expect((await latestZax(feed("linux", body))).url).toBe("https://example/page");
  });

  it("refuses the same in the release page, falling back to the feed it just read", async () => {
    const body = JSON.stringify({ tag_name: "v0.9", html_url: "file:///etc/passwd", assets: [] });
    expect((await latestZax(feed("linux", body))).url).toBe(URL);
  });
});
