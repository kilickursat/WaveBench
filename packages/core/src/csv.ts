// Delimited-text import. Values are data, never code: nothing here evaluates imported text. Rows are never
// dropped or re-ordered; a cell that cannot be read becomes NaN and is reported as an issue.
import { WaveBenchError } from "./errors";

export type Delimiter = "," | ";" | "\t" | "|" | "whitespace";
export type DecimalSeparator = "." | ",";
export type ColumnKind = "number" | "datetime" | "time-of-day" | "text" | "empty";

export const DELIMITERS: readonly Delimiter[] = ["\t", ",", ";", "|", "whitespace"];

export interface SniffResult {
  delimiter: Delimiter;
  decimal: DecimalSeparator;
  /** Raw lines before the header row (or before the first data row when there is no header). */
  skipLines: number;
  hasHeader: boolean;
  columnNames: string[];
  columnKinds: ColumnKind[];
  /** First data rows as tokens, with their 1-based line numbers. */
  preview: string[][];
  previewLines: number[];
  /** Leading lines that are not part of the table (metadata, comments), trimmed. */
  metadataLines: string[];
}

export interface ParseOptions {
  delimiter: Delimiter;
  decimal: DecimalSeparator;
  skipLines: number;
  hasHeader: boolean;
  /** Column names when there is no header row. */
  columnNames?: string[];
  /** Column kinds from {@link sniffDelimited}; "text" and "empty" columns are not read. */
  columnKinds?: ColumnKind[];
  maxIssues?: number;
}

export type IssueKind = "missing" | "non-numeric" | "too-few-fields" | "too-many-fields" | "bad-time";

export interface ParseIssue {
  /** 1-based line number in the file. */
  line: number;
  column: number | null;
  kind: IssueKind;
  token?: string;
}

export interface ParsedTable {
  names: string[];
  kinds: ColumnKind[];
  /** Numeric columns; datetime and time-of-day columns hold seconds relative to their first value. */
  columns: (Float64Array | null)[];
  /** First datetime / time-of-day token of each such column (its origin), else null. */
  timeOrigins: (string | null)[];
  rowCount: number;
  issues: ParseIssue[];
  issueCount: number;
  /** Unreadable or missing cells per column. */
  columnIssueCounts: number[];
  rowsWithIssues: number;
  skippedCommentLines: number;
  skippedBlankLines: number;
  firstDataLine: number;
}

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const TOD_RE = /^(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d+))?$/;
const MISSING = new Set(["", "nan", "na", "n/a", "null", "none", "-"]);

export function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("#") || t.startsWith("%") || t.startsWith("//");
}

export function splitLine(line: string, delimiter: Delimiter): string[] {
  if (delimiter === "whitespace") {
    const t = line.trim();
    return t ? t.split(/\s+/) : [""];
  }
  if (line.indexOf('"') < 0) return line.split(delimiter);
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** A finite decimal number, or NaN. Hexadecimal, "Infinity" and empty strings are not numbers here. */
export function parseNumber(token: string, decimal: DecimalSeparator = "."): number {
  let t = token.trim();
  if (decimal === ",") t = t.replace(",", ".");
  if (!NUMBER_RE.test(t)) return NaN;
  const v = Number(t);
  return Number.isFinite(v) ? v : NaN;
}

export function isMissingToken(token: string): boolean {
  return MISSING.has(token.trim().toLowerCase());
}

/** Integer epoch seconds plus a fraction, so that sub-millisecond digits survive (Date.parse keeps only ms). */
export interface SplitTime {
  sec: number;
  frac: number;
}

/**
 * ISO 8601 date-time with optional fraction and zone. A missing zone is read with UTC arithmetic: differences
 * between rows are exact, but no daylight-saving or local-time correction is applied.
 */
export function parseIsoDateTime(token: string): SplitTime | null {
  const m = ISO_RE.exec(token.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 24 || mi > 59 || s > 60) return null;
  let offset = 0;
  const zone = m[8];
  if (zone && zone.toUpperCase() !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    offset = sign * (Number(digits.slice(0, 2)) * 3600 + Number(digits.slice(2, 4) || "0") * 60);
  }
  const sec = Date.UTC(y, mo - 1, d, h, mi, s) / 1000 - offset;
  return { sec, frac: m[7] ? Number(`0.${m[7]}`) : 0 };
}

/** hh:mm:ss[.fff] as seconds since midnight. */
export function parseTimeOfDay(token: string): SplitTime | null {
  const m = TOD_RE.exec(token.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = Number(m[3]);
  if (h > 24 || mi > 59 || s > 60) return null;
  return { sec: h * 3600 + mi * 60 + s, frac: m[4] ? Number(`0.${m[4]}`) : 0 };
}

export function classifyToken(token: string, decimal: DecimalSeparator): ColumnKind {
  if (isMissingToken(token)) return "empty";
  if (!Number.isNaN(parseNumber(token, decimal))) return "number";
  if (parseIsoDateTime(token)) return "datetime";
  if (parseTimeOfDay(token)) return "time-of-day";
  return "text";
}

function splitLines(text: string): string[] {
  return text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
}

/** Choices made by the user that the sniffer must respect instead of detecting. */
export interface SniffOverrides {
  delimiter?: Delimiter;
  decimal?: DecimalSeparator;
  skipLines?: number;
  hasHeader?: boolean;
}

/** Detect delimiter, decimal separator, header and leading metadata from the start of a file. */
export function sniffDelimited(sample: string, overrides: SniffOverrides = {}, maxLines = 400): SniffResult {
  const all = splitLines(sample);
  // The sample may end mid-line; drop the fragment unless the sample is the whole file.
  const lines = all.length > 1 ? all.slice(0, Math.min(all.length - 1, maxLines)) : all;
  const skip = overrides.skipLines ?? 0;
  const candidates = lines
    .map((line, index) => ({ line, index }))
    .filter((c) => c.index >= skip && c.line.trim() !== "" && !isCommentLine(c.line));
  if (!candidates.length) throw new WaveBenchError("EMPTY_FILE", "no data lines found");
  const tail = candidates.slice(Math.max(0, candidates.length - 120));
  // Score = share of lines with the most common field count x share of their fields that read as numbers or
  // times. The second factor matters: with decimal commas, splitting on "," is just as consistent as ";".
  const decimalFor = (d: Delimiter): DecimalSeparator => {
    if (d === ",") return ".";
    let comma = 0;
    let dot = 0;
    for (const c of tail) {
      for (const tok of splitLine(c.line, d)) {
        const t = tok.trim();
        if (/^[+-]?\d+,\d+(?:[eE][+-]?\d+)?$/.test(t)) comma++;
        else if (/^[+-]?\d*\.\d+(?:[eE][+-]?\d+)?$/.test(t)) dot++;
      }
    }
    return comma > dot ? "," : ".";
  };
  const modeOf = (d: Delimiter) => {
    const freq = new Map<number, number>();
    for (const c of tail) {
      const n = splitLine(c.line, d).length;
      freq.set(n, (freq.get(n) ?? 0) + 1);
    }
    let mode = 1;
    let count = 0;
    for (const [n, f] of freq) if (f > count || (f === count && n > mode)) [mode, count] = [n, f];
    return { mode, consistency: count / tail.length };
  };
  const readableShare = (d: Delimiter, dec: DecimalSeparator, width: number) => {
    let readable = 0;
    let total = 0;
    for (const c of tail) {
      const tokens = splitLine(c.line, d);
      if (tokens.length !== width) continue;
      for (const t of tokens) {
        total++;
        const k = classifyToken(t, dec);
        if (k === "number" || k === "datetime" || k === "time-of-day" || k === "empty") readable++;
      }
    }
    return total ? readable / total : 0;
  };
  let best: { d: Delimiter; mode: number; score: number } = { d: ",", mode: 1, score: 0 };
  for (const d of DELIMITERS) {
    const { mode, consistency } = modeOf(d);
    if (mode < 2) continue;
    const score = consistency * readableShare(d, decimalFor(d), mode);
    if (score > best.score + 1e-9) best = { d, mode, score };
  }
  const delimiter: Delimiter = overrides.delimiter ?? best.d;
  const width = overrides.delimiter ? modeOf(delimiter).mode : best.mode;
  const decimal: DecimalSeparator = delimiter === "," ? "." : overrides.decimal ?? decimalFor(delimiter);
  const isDataLine = (line: string) => {
    const tokens = splitLine(line, delimiter);
    if (tokens.length !== width) return false;
    let readable = 0;
    for (const t of tokens) {
      const k = classifyToken(t, decimal);
      if (k === "number" || k === "datetime" || k === "time-of-day") readable++;
    }
    return readable >= Math.max(1, Math.ceil(tokens.length / 2));
  };
  let first: number;
  let hasHeader: boolean;
  if (overrides.hasHeader !== undefined && overrides.skipLines !== undefined) {
    // The user fixed where the table starts: the first line after the skipped ones is a header or data.
    hasHeader = overrides.hasHeader;
    first = hasHeader ? 1 : 0;
    if (first >= candidates.length) throw new WaveBenchError("NO_NUMERIC_DATA", "no data lines after the skipped lines");
  } else {
    first = candidates.findIndex((c, i) => isDataLine(c.line) && (i + 1 >= candidates.length || isDataLine(candidates[i + 1].line)));
    if (first < 0) first = candidates.findIndex((c) => isDataLine(c.line));
    if (first < 0) throw new WaveBenchError("NO_NUMERIC_DATA", "no rows of numbers were found in the first lines of the file");
    const candidate = first > 0 ? candidates[first - 1] : null;
    hasHeader =
      !!candidate &&
      splitLine(candidate.line, delimiter).length === width &&
      splitLine(candidate.line, delimiter).some((t) => classifyToken(t, decimal) === "text");
  }
  const dataLine = candidates[first];
  const headerCandidate = hasHeader ? candidates[first - 1] : null;
  const skipLines = hasHeader ? headerCandidate!.index : dataLine.index;
  const rawNames = hasHeader ? splitLine(headerCandidate!.line, delimiter) : [];
  const columnNames = uniqueNames(width, rawNames);
  const previewRows = candidates.slice(first, first + 12);
  const preview = previewRows.map((c) => normaliseWidth(splitLine(c.line, delimiter), width));
  const columnKinds: ColumnKind[] = [];
  for (let col = 0; col < width; col++) {
    let kind: ColumnKind = "empty";
    for (const row of preview) {
      const k = classifyToken(row[col] ?? "", decimal);
      if (k !== "empty") {
        kind = k;
        break;
      }
    }
    columnKinds.push(kind);
  }
  return {
    delimiter, decimal, skipLines, hasHeader, columnNames, columnKinds, preview,
    previewLines: previewRows.map((c) => c.index + 1),
    metadataLines: lines.slice(0, skipLines).map((l) => l.trim()).filter(Boolean).slice(0, 20),
  };
}

function normaliseWidth(tokens: string[], width: number): string[] {
  const out = tokens.slice(0, width);
  while (out.length < width) out.push("");
  return out;
}

export function uniqueNames(width: number, raw: string[]): string[] {
  const seen = new Map<string, number>();
  const names: string[] = [];
  for (let i = 0; i < width; i++) {
    let name = (raw[i] ?? "").trim().replace(/\s+/g, " ").slice(0, 80) || `Column ${i + 1}`;
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    if (n) name = `${name} (${n + 1})`;
    names.push(name);
  }
  return names;
}

class GrowableColumn {
  data: Float64Array;
  length = 0;

  constructor(capacity: number) {
    this.data = new Float64Array(Math.max(16, capacity));
  }

  push(v: number): void {
    if (this.length === this.data.length) {
      const next = new Float64Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }

  finish(): Float64Array {
    return this.length === this.data.length ? this.data : this.data.slice(0, this.length);
  }
}

/** Streaming parser: feed text chunks of any size with {@link push}, then call {@link finish}. */
export class DelimitedParser {
  private readonly opts: Required<Omit<ParseOptions, "columnNames" | "columnKinds">> &
    Pick<ParseOptions, "columnNames" | "columnKinds">;
  private remainder = "";
  private lineNo = 0;
  private names: string[] | null = null;
  private kinds: ColumnKind[] | null = null;
  private columns: (GrowableColumn | null)[] = [];
  private origins: (SplitTime | null)[] = [];
  private originText: (string | null)[] = [];
  private rows = 0;
  private issues: ParseIssue[] = [];
  private issueCount = 0;
  private columnIssues: number[] = [];
  private rowsWithIssues = 0;
  private comments = 0;
  private blanks = 0;
  private firstDataLine = 0;
  private readonly capacity: number;

  constructor(options: ParseOptions, expectedRows = 1024) {
    this.opts = { maxIssues: 200, ...options };
    this.capacity = expectedRows;
  }

  push(chunk: string): void {
    const text = this.remainder + chunk;
    let start = 0;
    for (;;) {
      const nl = text.indexOf("\n", start);
      if (nl < 0) break;
      const end = nl > start && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
      this.line(text.slice(start, end));
      start = nl + 1;
    }
    this.remainder = text.slice(start);
  }

  finish(): ParsedTable {
    if (this.remainder) {
      const r = this.remainder.endsWith("\r") ? this.remainder.slice(0, -1) : this.remainder;
      this.remainder = "";
      this.line(r);
    }
    if (!this.names || !this.kinds) throw new WaveBenchError("NO_NUMERIC_DATA", "the file has no data rows");
    return {
      names: this.names,
      kinds: this.kinds,
      columns: this.columns.map((c) => (c ? c.finish() : null)),
      timeOrigins: this.originText,
      rowCount: this.rows,
      issues: this.issues,
      issueCount: this.issueCount,
      columnIssueCounts: this.columnIssues,
      rowsWithIssues: this.rowsWithIssues,
      skippedCommentLines: this.comments,
      skippedBlankLines: this.blanks,
      firstDataLine: this.firstDataLine,
    };
  }

  private issue(issue: ParseIssue): void {
    this.issueCount++;
    if (issue.column !== null) this.columnIssues[issue.column]++;
    if (this.issues.length < this.opts.maxIssues) this.issues.push(issue);
  }

  private line(raw: string): void {
    const lineNo = ++this.lineNo;
    const text = lineNo === 1 ? raw.replace(/^﻿/, "") : raw;
    if (lineNo <= this.opts.skipLines) return;
    if (text.trim() === "") {
      if (this.names) this.blanks++;
      return;
    }
    if (isCommentLine(text)) {
      this.comments++;
      return;
    }
    const tokens = splitLine(text, this.opts.delimiter);
    if (!this.names) {
      if (this.opts.hasHeader) {
        this.names = uniqueNames(tokens.length, tokens);
        return;
      }
      this.names = uniqueNames(tokens.length, this.opts.columnNames ?? []);
    }
    if (!this.kinds) this.initColumns(tokens);
    const names = this.names!;
    const kinds = this.kinds!;
    if (!this.firstDataLine) this.firstDataLine = lineNo;
    const before = this.issueCount;
    if (tokens.length < names.length) this.issue({ line: lineNo, column: null, kind: "too-few-fields" });
    else if (tokens.length > names.length && tokens.slice(names.length).some((t) => t.trim() !== "")) {
      this.issue({ line: lineNo, column: null, kind: "too-many-fields" });
    }
    for (let c = 0; c < names.length; c++) {
      const col = this.columns[c];
      if (!col) continue;
      const token = c < tokens.length ? tokens[c] : "";
      const kind = kinds[c];
      if (kind === "number") {
        const v = parseNumber(token, this.opts.decimal);
        if (Number.isNaN(v)) {
          this.issue({ line: lineNo, column: c, kind: isMissingToken(token) ? "missing" : "non-numeric", token: token.slice(0, 40) });
        }
        col.push(v);
      } else {
        const t = kind === "datetime" ? parseIsoDateTime(token) : parseTimeOfDay(token);
        if (!t) {
          this.issue({ line: lineNo, column: c, kind: isMissingToken(token) ? "missing" : "bad-time", token: token.slice(0, 40) });
          col.push(NaN);
        } else {
          let origin = this.origins[c];
          if (!origin) {
            origin = t;
            this.origins[c] = t;
            this.originText[c] = token.trim();
          }
          col.push(t.sec - origin.sec + (t.frac - origin.frac));
        }
      }
    }
    if (this.issueCount > before) this.rowsWithIssues++;
    this.rows++;
  }

  private initColumns(tokens: string[]): void {
    const names = this.names!;
    const given = this.opts.columnKinds;
    this.kinds = names.map((_, c) => {
      if (given && given[c]) return given[c];
      const k = classifyToken(tokens[c] ?? "", this.opts.decimal);
      // A first-row gap does not make a numeric column textual.
      return k === "empty" ? "number" : k;
    });
    this.columns = this.kinds.map((k) => (k === "text" || k === "empty" ? null : new GrowableColumn(this.capacity)));
    this.columnIssues = names.map(() => 0);
    this.origins = names.map(() => null);
    this.originText = names.map(() => null);
  }
}

/** Parse a whole string at once (small files, tests). */
export function parseDelimited(text: string, options: ParseOptions): ParsedTable {
  const parser = new DelimitedParser(options, Math.max(16, Math.round(text.length / 24)));
  parser.push(text);
  return parser.finish();
}

/** Quote a CSV text field and neutralise spreadsheet formulas (=, +, -, @ prefixes). */
export function csvText(value: string): string {
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
