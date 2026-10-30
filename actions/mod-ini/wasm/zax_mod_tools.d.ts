/* tslint:disable */
/* eslint-disable */

/**
 * `{ ok, said, complaints }`, the two lists being lines for standard output and standard error.
 *
 * # Errors
 *
 * Throws for a match other than `soft` or `hard`, and rethrows whatever the reader threw.
 */
export function checkModIni(manifest: Uint8Array, manifest_name: string, match_: string, read: Function): { ok: boolean; said: string[]; complaints: string[] };

/**
 * # Errors
 *
 * Throws the parser's refusal as an `Error`.
 */
export function describeManifest(bytes: Uint8Array): string[];

/**
 * `{ files: [name, bytes][], settings }`, the names being what the settings address.
 *
 * # Errors
 *
 * Throws the parser's or the generator's refusal as an `Error`, and rethrows whatever the reader threw.
 */
export function generateModIni(manifest: Uint8Array, read: Function): { files: [string, Uint8Array][]; settings: number };

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly checkModIni: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly describeManifest: (a: number, b: number, c: number) => void;
    readonly generateModIni: (a: number, b: number, c: number, d: number) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
