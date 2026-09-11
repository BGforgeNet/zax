import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import { takeInstallLock, type InstallLock } from "./install-lock.js";

const INSTALL = "/games/fallout2";
const LOCK = `${INSTALL}/.zax-lock`;

const held = (claim: Awaited<ReturnType<typeof takeInstallLock>>): InstallLock => {
  if ("refused" in claim) throw new Error(`expected the claim to be granted, and it said: ${claim.refused}`);
  return claim;
};

const refusalOf = (claim: Awaited<ReturnType<typeof takeInstallLock>>): string => {
  if (!("refused" in claim)) throw new Error("expected the claim to be refused, and it was granted");
  return claim.refused;
};

/** A lock file as another run would have left it, written straight to disk rather than through a claim. */
const leftBehind = async (platform: MemoryPlatform, record: Record<string, unknown>): Promise<void> => {
  await platform.fs.write(LOCK, new TextEncoder().encode(JSON.stringify(record)));
};

describe("claiming a game directory", () => {
  it("writes who holds it, so a later run has something to judge", async () => {
    const platform = new MemoryPlatform({ dirs: [INSTALL] });

    const claim = held(await takeInstallLock(platform, INSTALL, "Installing RPU"));

    const written: unknown = JSON.parse(new TextDecoder().decode(await platform.fs.read(LOCK)));
    expect(written).toMatchObject({ host: "memory", pid: 1, what: "Installing RPU" });
    await claim.release();
    expect(await platform.fs.stat(LOCK), "and takes it away again").toBeNull();
  });

  it("refuses a second claim while the first is held, naming what holds it", async () => {
    const platform = new MemoryPlatform({ dirs: [INSTALL], livePids: [1] });
    const first = held(await takeInstallLock(platform, INSTALL, "Installing RPU"));

    const refused = refusalOf(await takeInstallLock(platform, INSTALL, "Installing UPU"));

    // Named rather than a bare "busy": what the user has to act on is the other operation, not this one.
    expect(refused).toContain("Installing RPU is already running in this game folder on this machine");
    expect(refused).toContain("process 1");
    await first.release();
  });

  it("takes over a lock whose process is no longer running", async () => {
    // The shape a run killed part way through leaves: a lock naming an id this machine is not running. Nothing
    // is writing under it, so stranding the install behind it would be the worse of the two failures.
    const platform = new MemoryPlatform({ dirs: [INSTALL] });
    await leftBehind(platform, { host: "memory", pid: 4321, what: "Installing RPU", taken: 1 });

    const claim = held(await takeInstallLock(platform, INSTALL, "Installing UPU"));

    const written: unknown = JSON.parse(new TextDecoder().decode(await platform.fs.read(LOCK)));
    expect(written).toMatchObject({ pid: 1, what: "Installing UPU" });
    await claim.release();
  });

  it("leaves a lock from another machine alone, whatever it says", async () => {
    // No id here can be asked about, so age proves nothing: the run that took it belongs to somebody else and
    // breaking it is the second writer this exists to prevent.
    const platform = new MemoryPlatform({ dirs: [INSTALL] });
    await leftBehind(platform, { host: "someone-else", pid: 4321, what: "Installing RPU", taken: 1 });

    expect(refusalOf(await takeInstallLock(platform, INSTALL, "Installing UPU"))).toContain(
      "already running in this game folder on someone-else",
    );
  });

  it("claims over a lock it cannot read rather than being stopped by one", async () => {
    // What a process killed mid-write leaves. The file is ZAX's own, so nothing a user wrote is being
    // discarded, and treating it as a refusal would lock the folder for good with no way back.
    const platform = new MemoryPlatform({ dirs: [INSTALL] });
    await platform.fs.write(LOCK, new TextEncoder().encode("{ truncated"));

    const claim = held(await takeInstallLock(platform, INSTALL, "Installing UPU"));
    await claim.release();
  });

  it("names the installer once it starts, which is the process that outlives ZAX", async () => {
    const platform = new MemoryPlatform({ dirs: [INSTALL] });
    const claim = held(await takeInstallLock(platform, INSTALL, "Installing RPU"));

    await claim.handOver(9876, "/tmp/zax/rpu_v2.4.34.exe");

    const written: unknown = JSON.parse(new TextDecoder().decode(await platform.fs.read(LOCK)));
    // The whole point of the hand-over: a lock still naming ZAX reads as abandoned the moment ZAX dies, which
    // is exactly when the installer is still writing. The command goes with it, so a later run can tell the
    // installer from whatever else the system may have given that id to since.
    expect(written).toMatchObject({ pid: 9876, what: "Installing RPU", command: "/tmp/zax/rpu_v2.4.34.exe" });
    await claim.release();
  });

  it("takes over where the id is alive as something else entirely", async () => {
    // The reuse case. The id is running, so liveness alone would refuse for good; what it is running has
    // nothing to do with this install, which is what says the installer is long gone.
    const platform = new MemoryPlatform({
      dirs: [INSTALL],
      livePids: [9876],
      commands: { 9876: "/usr/lib/firefox/firefox --new-window" },
    });
    await leftBehind(platform, { host: "memory", pid: 9876, what: "Installing RPU", command: "rpu_v2.4.34.exe" });

    const claim = held(await takeInstallLock(platform, INSTALL, "Installing UPU"));
    await claim.release();
  });

  it("still refuses where the id is alive as the installer it was handed to", async () => {
    const platform = new MemoryPlatform({
      dirs: [INSTALL],
      livePids: [9876],
      commands: { 9876: "/tmp/zax/rpu_v2.4.34.exe /DIR=/games/fallout2 /NORESTART" },
    });
    await leftBehind(platform, {
      host: "memory",
      pid: 9876,
      what: "Installing RPU",
      command: "/tmp/zax/rpu_v2.4.34.exe",
    });

    expect(refusalOf(await takeInstallLock(platform, INSTALL, "Installing UPU"))).toContain("process 9876");
  });

  it("refuses a live id where the host will not say what it is running", async () => {
    // Null is "cannot tell", not "not the one you meant". Reading it as a mismatch would break every claim on
    // a host with no answer, which is the failure that lets two installers into one folder.
    const platform = new MemoryPlatform({ dirs: [INSTALL], livePids: [9876] });
    await leftBehind(platform, { host: "memory", pid: 9876, what: "Installing RPU", command: "rpu.exe" });

    expect(refusalOf(await takeInstallLock(platform, INSTALL, "Installing UPU"))).toContain("process 9876");
  });

  it("refuses while the installer it was handed to is still running", async () => {
    const platform = new MemoryPlatform({ dirs: [INSTALL], livePids: [9876] });
    await leftBehind(platform, { host: "memory", pid: 9876, what: "Installing RPU", taken: 1 });

    expect(refusalOf(await takeInstallLock(platform, INSTALL, "Installing RPU"))).toContain("process 9876");
  });
});
