/**
 * Lossless INI reader/writer.
 *
 * Config files belong to the user and carry hand-written comments, so anything not understood passes through
 * untouched and setting one key rewrites exactly one line. Bytes are carried as latin1 strings: that mapping is
 * one-to-one and reversible in JavaScript, so a file in an unknown legacy codepage round-trips byte for byte
 * without ever being decoded as something it is not.
 */

import { latin1, latin1Bytes, splitLines } from "./text.js";

export type IniNode =
  | { kind: "blank"; raw: string }
  | { kind: "comment"; raw: string }
  | { kind: "section"; name: string; raw: string }
  | { kind: "entry"; section: string; key: string; value: string; raw: string; parts: EntryParts }
  | { kind: "unknown"; raw: string };

/** Pieces of an entry line, kept so a value change rewrites nothing but the value. */
interface EntryParts {
  indent: string;
  key: string;
  separator: string;
  /** Inline comment after the value, with its leading whitespace, e.g. " ; ORIGINAL 480". */
  comment: string;
  trailing: string;
  eol: string;
}

const SECTION_RE = /^(\s*)\[([^\]]*)\](\s*)$/;
// The value stops at an inline comment: a ";" or "#" preceded by whitespace. Requiring the whitespace keeps a
// separator inside a value (a path, a list) from being mistaken for one.
const ENTRY_RE = /^(\s*)([^=\s][^=]*?)(\s*=\s*)(.*?)(\s+[;#].*?)?(\s*)$/;
const COMMENT_RE = /^\s*[;#]/;

const fold = (s: string) => s.toLowerCase();

export class IniDocument {
  private constructor(
    private readonly nodes: IniNode[],
    /** Terminator used for lines this document adds. */
    readonly dominantEol: string,
  ) {}

  static parse(text: string): IniDocument {
    const nodes: IniNode[] = [];
    let crlf = 0;
    let lf = 0;
    let section = "";

    for (const { body, eol } of splitLines(text)) {
      if (eol === "\r\n") crlf++;
      else if (eol === "\n") lf++;
      const raw = body + eol;

      if (body.trim() === "") {
        nodes.push({ kind: "blank", raw });
        continue;
      }
      if (COMMENT_RE.test(body)) {
        nodes.push({ kind: "comment", raw });
        continue;
      }
      const sec = SECTION_RE.exec(body);
      if (sec) {
        section = sec[2] ?? "";
        nodes.push({ kind: "section", name: section, raw });
        continue;
      }
      const ent = ENTRY_RE.exec(body);
      if (ent) {
        const [, indent = "", key = "", separator = "=", value = "", comment = "", trailing = ""] = ent;
        nodes.push({
          kind: "entry",
          section,
          key,
          value,
          raw,
          parts: { indent, key, separator, comment, trailing, eol },
        });
        continue;
      }
      nodes.push({ kind: "unknown", raw });
    }

    return new IniDocument(nodes, crlf >= lf && crlf > 0 ? "\r\n" : "\n");
  }

  /** Decode bytes as latin1 so the round-trip is byte-exact whatever the file's real encoding is. */
  static parseBytes(bytes: Uint8Array): IniDocument {
    return IniDocument.parse(latin1(bytes));
  }

  get(section: string, key: string): string | undefined {
    return this.findEntry(section, key)?.value;
  }

  /**
   * Every entry the file actually contains, with the comment block directly above it. sfall documents most of
   * its settings inline, so that comment is the only description available for keys the catalog does not model.
   */
  entries(): Array<{ section: string; key: string; value: string; comment?: string }> {
    const out: Array<{ section: string; key: string; value: string; comment?: string }> = [];
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i]!;
      if (n.kind !== "entry") continue;
      const comment: string[] = [];
      for (let j = i - 1; j >= 0; j--) {
        const prev = this.nodes[j]!;
        if (prev.kind !== "comment") break;
        const text = prev.raw.replace(/^\s*[;#]\s?/, "").trimEnd();
        // A run of X characters is sfall's section divider, not documentation.
        if (/^X{6,}$/.test(text.trim())) break;
        comment.unshift(text);
      }
      out.push({
        section: n.section,
        key: n.key,
        value: n.value,
        ...(comment.length ? { comment: comment.join(" ").trim() } : {}),
      });
    }
    return out;
  }

  /** Every section present in the file, in order of first appearance. */
  sections(): string[] {
    const seen: string[] = [];
    for (const n of this.nodes) if (n.kind === "section" && !seen.includes(n.name)) seen.push(n.name);
    return seen;
  }

  /**
   * Write a value, rewriting one line and only when it actually differs. A missing key is appended to its
   * section; a missing section is appended to the file.
   */
  set(section: string, key: string, value: string): void {
    const existing = this.findEntry(section, key);
    if (existing) {
      if (existing.value === value) return;
      const p = existing.parts;
      existing.value = value;
      // The inline comment is carried across: it is the author's note, not part of the value.
      existing.raw = p.indent + p.key + p.separator + value + p.comment + p.trailing + p.eol;
      return;
    }

    const eol = this.dominantEol;
    const entry: IniNode = {
      kind: "entry",
      section,
      key,
      value,
      raw: `${key}=${value}${eol}`,
      parts: { indent: "", key, separator: "=", comment: "", trailing: "", eol },
    };

    const at = this.endOfSection(section);
    if (at === -1) {
      this.terminateLine(this.nodes.length - 1);
      this.nodes.push({ kind: "section", name: section, raw: `[${section}]${eol}` }, entry);
    } else {
      // The line we insert after need not be the file's last, but it can be - config files are not required to
      // end with a newline, and splicing after an unterminated line would join two keys into one.
      this.terminateLine(at - 1);
      this.nodes.splice(at, 0, entry);
    }
  }

  toString(): string {
    return this.nodes.map((n) => n.raw).join("");
  }

  toBytes(): Uint8Array {
    return latin1Bytes(this.toString());
  }

  private findEntry(section: string, key: string) {
    for (const n of this.nodes) {
      if (n.kind === "entry" && fold(n.section) === fold(section) && fold(n.key) === fold(key)) return n;
    }
    return undefined;
  }

  /** Index just past the last meaningful line of a section, or -1 when the section is absent. */
  private endOfSection(section: string): number {
    let inSection = false;
    let last = -1;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i]!;
      if (n.kind === "section") {
        if (inSection) break;
        inSection = fold(n.name) === fold(section);
        if (inSection) last = i + 1;
        continue;
      }
      if (inSection && n.kind !== "blank") last = i + 1;
    }
    return inSection ? last : -1;
  }

  /** Give the node at `index` a line terminator if it lacks one, so the next line starts on its own. */
  private terminateLine(index: number): void {
    const node = this.nodes[index];
    if (node && node.raw !== "" && !node.raw.endsWith("\n")) node.raw += this.dominantEol;
  }
}
