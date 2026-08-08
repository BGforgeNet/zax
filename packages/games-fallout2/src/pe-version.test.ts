import { describe, expect, it } from "vitest";
import { library } from "./pe-fixture.js";
import { readFileVersion } from "./pe-version.js";

describe("reading a library's version", () => {
  it("reads it from the image's own version resource", () => {
    expect(readFileVersion(library({ FileVersion: "4.5", ProductName: "sfall" }))).toBe("4.5");
  });

  it("reports nothing for a file that is not a library at all", () => {
    expect(readFileVersion(new TextEncoder().encode("this is not a DLL"))).toBeNull();
  });

  it("reports nothing for a library that records no version", () => {
    expect(readFileVersion(library({ ProductName: "something else" }))).toBeNull();
  });

  // The two producers ZAX reads write the same version in different formats, so the reader has to fold them
  // onto one. These are the exact strings in the shipped f2_res.dll 4.1.8 and ddraw.dll 4.5.
  it("folds the quad the hi-res patch writes onto the version it publishes", () => {
    expect(readFileVersion(library({ FileVersion: "4, 1, 8, 0" }))).toBe("4.1.8");
  });

  it("leaves a version that is already written plainly alone", () => {
    expect(readFileVersion(library({ FileVersion: "3.3a" }))).toBe("3.3a");
  });

  // Dropping trailing zeroes stops at two components, so a two-part version never loses its minor.
  it("keeps a minor version of zero", () => {
    expect(readFileVersion(library({ FileVersion: "4.0" }))).toBe("4.0");
  });
});
