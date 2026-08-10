/**
 * Bytes to text and back, and text into lines.
 *
 * latin1 maps a byte to a code point one to one, so a file in an unknown legacy codepage round-trips byte for
 * byte without ever being decoded as something it is not. Shared rather than written per reader: every file
 * this application rewrites has to come back out exactly as it went in, and one of three copies drifting is
 * how that stops being true.
 */

export function latin1(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

export function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Split into lines, each retaining its own terminator. A final line without one keeps an empty terminator. */
export function splitLines(text: string): Array<{ body: string; eol: string }> {
  const out: Array<{ body: string; eol: string }> = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      const hasCr = i > start && text[i - 1] === "\r";
      out.push({ body: text.slice(start, hasCr ? i - 1 : i), eol: hasCr ? "\r\n" : "\n" });
      start = i + 1;
    }
  }
  if (start < text.length) out.push({ body: text.slice(start), eol: "" });
  return out;
}
