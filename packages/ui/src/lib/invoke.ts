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

export const PREVIEW_REASON = "The browser preview has no machine to reach - this needs the desktop build.";

/** What a long operation reports as it runs, as one message. */
export interface OperationProgress {
  step: string;
  received?: number;
  total?: number;
  cancellable: boolean;
}

/** Whether a Tauri shell is presenting this page, which is what decides the host. */
const onDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** The preview's machine, made once and only where there is no shell. */
let previewMachine: Promise<{ invoke(name: string, args: string): string; onProgress(listener: (said: string) => void): void }> | null =
  null;

async function preview(): Promise<{
  invoke(name: string, args: string): string;
  onProgress(listener: (said: string) => void): void;
}> {
  previewMachine ??= (async () => {
    const wasm = await import("./preview-wasm/zax_preview.js");
    await wasm.default();
    return new wasm.ZaxPreview();
  })();
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
  return JSON.parse(answered) as T;
}

/** Where a long operation's progress arrives, whichever host is answering. */
export async function onProgress(listener: (progress: OperationProgress) => void): Promise<void> {
  if (onDesktop) {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<OperationProgress>("zax://progress", (event) => listener(event.payload));
    return;
  }
  const machine = await preview();
  machine.onProgress((said) => listener(JSON.parse(said) as OperationProgress));
}

/** Whether this is the browser preview, which several surfaces say out loud. */
export const isPreview = !onDesktop;
