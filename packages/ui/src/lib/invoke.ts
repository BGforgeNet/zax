/**
 * The one call every command goes through, and the choice of which machine answers it.
 *
 * The desktop build reaches the shell's Tauri commands. Opened in a browser there is no shell, so the
 * same commands are answered by the domain compiled to WebAssembly over an in-memory machine - the same
 * code, under the same names, with the same argument shapes. Which means the cheap host cannot be laxer
 * than the expensive one: a command only one of them answers is a build failure in the preview's own
 * tests rather than a button that silently does nothing.
 *
 * The preview is loaded only when there is no shell, so the desktop build carries neither it nor the
 * fixture it is seeded with.
 */

import type { OperationProgress } from "./bindings/OperationProgress";

export const PREVIEW_REASON = "The browser preview has no machine to reach - this needs the desktop build.";

/** Whether a Tauri shell is presenting this page, which is what decides the host. */
const onDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** The preview machine as its WebAssembly wrapper presents it. */
export interface PreviewMachine {
  invoke(name: string, args: string): string;
  onProgress(listener: (said: string) => void): void;
  writeFile(path: string, bytes: Uint8Array): void;
  readFile(path: string): Uint8Array;
  removeFile(path: string): void;
}

/** The preview's machine, made once and only where there is no shell. */
let previewMachine: Promise<PreviewMachine> | null = null;
/** Where progress goes, kept so a machine made afresh reports to the same place. */
const progressListeners: Array<(progress: OperationProgress) => void> = [];

async function makePreview(): Promise<PreviewMachine> {
  const wasm = await import("./preview-wasm/zax_preview.js");
  await wasm.default();
  const machine = new wasm.ZaxPreview();
  machine.onProgress((said: string) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by the preview from the Rust type this binding was generated from.
    const progress = JSON.parse(said) as OperationProgress;
    for (const listener of progressListeners) listener(progress);
  });
  return machine;
}

/** The preview's machine, made on first use. */
async function preview(): Promise<PreviewMachine> {
  previewMachine ??= makePreview();
  return previewMachine;
}

/**
 * Replaces the preview's machine with a freshly seeded one. What a test starts from, so no case reads the
 * disk the last one wrote.
 */
export async function resetPreview(): Promise<PreviewMachine> {
  previewMachine = makePreview();
  return previewMachine;
}

/**
 * One command, by the name the shell registers it under.
 *
 * Both hosts answer with the operation's own sentence where it refused, which is what the interface
 * shows: the failure's kind does not survive either channel.
 */
export async function invoke<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (onDesktop) {
    const { invoke: toShell } = await import("@tauri-apps/api/core");
    return toShell<T>(name, args);
  }
  const machine = await preview();
  // Dropped rather than sent: the argument object carries `undefined` for every optional a caller left
  // out, and the preview refuses a field it does not know rather than reading one it cannot.
  const given = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
  let answered: string;
  try {
    answered = machine.invoke(name, JSON.stringify(given));
  } catch (error) {
    // The preview throws the sentence itself, which is what the shell's channel carries too.
    throw new Error(typeof error === "string" ? error : String(error));
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the answer is the command's own Rust type serialized, and `T` its generated binding: the same trust the shell's own `invoke<T>` extends.
  return JSON.parse(answered) as T;
}

/** Where a long operation's progress arrives, whichever host is answering. */
export async function onProgress(listener: (progress: OperationProgress) => void): Promise<void> {
  if (onDesktop) {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<OperationProgress>("zax://progress", (event) => listener(event.payload));
    return;
  }
  progressListeners.push(listener);
}

/** Whether this is the browser preview, which several surfaces say out loud. */
export const isPreview = !onDesktop;
