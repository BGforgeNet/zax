import { describe, expect, it } from "vitest";
import { fromMethods } from "@zax/fallout2/backend-methods";
import { createDispatch, describeError } from "./dispatch.js";

describe("dispatching a call from the renderer", () => {
  it("routes to the named operation with its arguments and hands back the answer", async () => {
    const seen: unknown[][] = [];
    const backend = fromMethods(
      (method) =>
        async (...args: unknown[]) => (seen.push([method, ...args]), "answer"),
    );
    const dispatch = createDispatch(backend, () => {});
    await expect(dispatch("saveState", [{ theme: "dark" }])).resolves.toBe("answer");
    expect(seen).toEqual([["saveState", { theme: "dark" }]]);
  });

  it("refuses a name outside the list, even one every object answers", async () => {
    const seen: string[] = [];
    const backend = fromMethods((method) => async () => (seen.push(method), "never"));
    const dispatch = createDispatch(backend, () => {});
    await expect(dispatch("toString", [])).rejects.toThrow("Unknown operation: toString");
    expect(seen, "nothing on the backend may run for an unknown name").toEqual([]);
  });

  it("logs a failure with its stack and rethrows it for the renderer", async () => {
    const lines: string[] = [];
    const boom = new Error("boom");
    const backend = fromMethods(() => async () => {
      throw boom;
    });
    const dispatch = createDispatch(backend, (line) => lines.push(line));
    await expect(dispatch("launch", [])).rejects.toBe(boom);
    expect(lines).toEqual([`launch failed: ${describeError(boom)}`]);
    expect(lines[0]).toContain(boom.stack);
  });
});
