import { describe, expect, it } from "vitest";
import { compareVersions } from "./version.js";

const older = (a: string, b: string) => compareVersions(a, b) < 0;

describe("comparing versions", () => {
  it("orders by number rather than by text, which is where a string comparison goes wrong", () => {
    expect(older("4.9", "4.10")).toBe(true);
    expect(older("3.9", "4.1")).toBe(true);
  });

  it("treats a missing component as zero", () => {
    expect(compareVersions("4.5", "4.5.0")).toBe(0);
    expect(older("4.5", "4.5.1")).toBe(true);
  });

  it("ignores a leading v, which is how a release tag is written", () => {
    expect(compareVersions("v0.8", "0.8")).toBe(0);
  });

  it("falls back to text when a component is not a number, rather than reporting equality", () => {
    expect(compareVersions("4.5-beta", "4.5")).not.toBe(0);
    expect(compareVersions("Unknown", "Unknown")).toBe(0);
  });

  it("decides the sfall override boundary the launch depends on", () => {
    expect(older("4.1.1", "4.1.2")).toBe(true);
    expect(older("4.1.2", "4.1.2")).toBe(false);
  });
});
