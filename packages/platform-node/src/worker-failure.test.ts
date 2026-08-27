import { describe, expect, it } from "vitest";
import { failureText } from "./worker-failure.js";

/**
 * The shapes emscripten throws, as its own glue declares them: `class ErrnoError { name = "ErrnoError";
 * constructor(errno) { this.errno = errno } }` and `class ExitStatus { name = "ExitStatus"; constructor(status)
 * { this.message = ...; this.status = status } }`. Neither extends `Error`, which is the whole reason this
 * module exists.
 *
 * Quoted rather than produced by a real run: since the extraction worker resolves a host directory before it
 * mounts one, no input this package accepts still gets emscripten to raise one - which was the point of that
 * change. The shapes hold for anything else thrown across the boundary all the same.
 */
const errnoError = (errno: number) => ({ name: "ErrnoError", errno });
const exitStatus = (status: number) => ({
  name: "ExitStatus",
  message: `Program terminated with exit(${status})`,
  status,
});

describe("describing what a worker threw", () => {
  it("keeps an error's own message", () => {
    expect(failureText(new Error("7-Zip is not there"))).toBe("7-Zip is not there");
  });

  it("names the errno of a thrown object that carries nothing else", () => {
    expect(failureText(errnoError(44))).toBe("ErrnoError (errno 44)");
  });

  it("keeps both the message and the status of a thrown object carrying each", () => {
    expect(failureText(exitStatus(2))).toBe("ExitStatus: Program terminated with exit(2) (status 2)");
  });

  it("falls back to the value itself where it is not an object at all", () => {
    // A C++ exception escaping the module arrives as the pointer to it, which is all there is to report.
    expect(failureText(3411440)).toBe("3411440");
  });
});
