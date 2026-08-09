import { describe, expect, it } from "vitest";
import { unwrapped } from "./ipc-error.js";

describe("taking Electron's wrapper off a rejection", () => {
  it("strips the channel prefix and the re-serialized error name", () => {
    expect(unwrapped(new Error("Error invoking remote method 'zax:call': Error: the real reason")).message).toBe(
      "the real reason",
    );
  });

  it("strips the prefix when no error name follows it", () => {
    expect(unwrapped(new Error("Error invoking remote method 'zax:call': just text")).message).toBe("just text");
  });

  it("leaves a message that never had the wrapper", () => {
    expect(unwrapped(new Error("plain failure")).message).toBe("plain failure");
  });

  it("stringifies something that is not an Error at all", () => {
    expect(unwrapped("boom").message).toBe("boom");
  });
});
