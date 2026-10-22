import { describe, expect, it } from "vitest";
import {
  analyzeTimestamps, csvText, DelimitedParser, parseDelimited, parseIsoDateTime, parseNumber, sniffDelimited,
  type ParseOptions,
} from "@wavebench/core";
import { repoFile } from "./helpers";

const optionsOf = (text: string): ParseOptions => {
  const s = sniffDelimited(text);
  return { delimiter: s.delimiter, decimal: s.decimal, skipLines: s.skipLines, hasHeader: s.hasHeader, columnKinds: s.columnKinds };
};

describe("number tokens", () => {
  it("accepts decimal and exponent forms, rejects hexadecimal, infinity and blanks", () => {
    expect(parseNumber("1.5e-3")).toBe(0.0015);
    expect(parseNumber(" -.25 ")).toBe(-0.25);
    expect(parseNumber("+7.")).toBe(7);
    expect(parseNumber("3,25", ",")).toBe(3.25);
    for (const bad of ["", " ", "0x10", "Infinity", "1e999", "1,5", "abc", "1.2.3"]) expect(parseNumber(bad)).toBeNaN();
  });
});

describe("sniffing", () => {
  it("comma with header, CRLF and BOM", () => {
    const s = sniffDelimited("﻿time_s,ax,ay,az\r\n0,1,2,3\r\n0.001,1.5,2.5,3.5\r\n");
    expect(s.delimiter).toBe(",");
    expect(s.hasHeader).toBe(true);
    expect(s.columnNames).toEqual(["time_s", "ax", "ay", "az"]);
    expect(s.skipLines).toBe(0);
  });

  it("semicolon with decimal comma, after metadata lines", () => {
    const text = "Logger X2\nRate: 100 Hz\n\nt;x;y;z\n0,00;1,25;-0,5;9,81\n0,01;1,30;-0,4;9,80\n0,02;1,20;-0,6;9,82\n";
    const s = sniffDelimited(text);
    expect(s.delimiter).toBe(";");
    expect(s.decimal).toBe(",");
    expect(s.hasHeader).toBe(true);
    expect(s.skipLines).toBe(3);
    expect(s.metadataLines).toEqual(["Logger X2", "Rate: 100 Hz"]);
    const t = parseDelimited(text, optionsOf(text));
    expect(t.rowCount).toBe(3);
    expect(Array.from(t.columns[1]!)).toEqual([1.25, 1.3, 1.2]);
    expect(t.issueCount).toBe(0);
  });

  it("decimal commas do not make the comma look like the delimiter, however many rows", () => {
    const rows = Array.from({ length: 500 }, (_, n) => `${(n * 2).toFixed(3)};${Math.sin(n).toFixed(5)};-0,5;9,81`.replace(/\./g, ","));
    const text = `Logger ACC-3\nRate: 500 Hz\n\nZeit [ms];Acc X;Acc Y;Acc Z\n${rows.join("\n")}\n`;
    const s = sniffDelimited(text);
    expect(s.delimiter).toBe(";");
    expect(s.decimal).toBe(",");
    expect(s.columnNames).toEqual(["Zeit [ms]", "Acc X", "Acc Y", "Acc Z"]);
    const t = parseDelimited(text, optionsOf(text));
    expect(t.rowCount).toBe(500);
    expect(t.columns[0]![3]).toBe(6);
    expect(t.issueCount).toBe(0);
  });

  it("a single column of numbers, with or without a header", () => {
    const s = sniffDelimited("accel\n0.5\n-0.25\n1e-3\n");
    expect(s.columnNames).toEqual(["accel"]);
    expect(s.hasHeader).toBe(true);
    const t = parseDelimited("0.5\n-0.25\n1e-3\n", optionsOf("0.5\n-0.25\n1e-3\n"));
    expect(Array.from(t.columns[0]!)).toEqual([0.5, -0.25, 0.001]);
  });

  it("user overrides are respected", () => {
    const text = "a|b\n1|2\n3|4\n";
    const s = sniffDelimited(text, { delimiter: "|", skipLines: 0, hasHeader: true });
    expect(s.delimiter).toBe("|");
    expect(s.columnNames).toEqual(["a", "b"]);
    const noHeader = sniffDelimited(text, { delimiter: "|", skipLines: 1, hasHeader: false });
    expect(noHeader.hasHeader).toBe(false);
    expect(noHeader.preview[0]).toEqual(["1", "2"]);
  });

  it("tab and whitespace tables without a header", () => {
    const tab = sniffDelimited("1\t2\t3\n4\t5\t6\n7\t8\t9\n");
    expect(tab.delimiter).toBe("\t");
    expect(tab.hasHeader).toBe(false);
    expect(tab.columnNames).toEqual(["Column 1", "Column 2", "Column 3"]);
    const ws = sniffDelimited("  1.0   2.0  3.0\n  4.0   5.0  6.0\n  7.0   8.0  9.0\n");
    expect(ws.delimiter).toBe("whitespace");
  });

  it("quoted header names and comment lines", () => {
    const text = '# exported\n"Time (s)","Acc X, g","Acc Y"\n0,1,2\n# pause\n1,3,4\n';
    const s = sniffDelimited(text);
    expect(s.columnNames).toEqual(["Time (s)", "Acc X, g", "Acc Y"]);
    const t = parseDelimited(text, optionsOf(text));
    expect(t.rowCount).toBe(2);
    expect(t.skippedCommentLines).toBe(1);
  });
});

describe("parsing", () => {
  it("keeps every row: bad cells become NaN with line numbers", () => {
    const text = "a,b\n1,2\n3,\n5,x\n7\n9,10,11\n";
    const t = parseDelimited(text, { delimiter: ",", decimal: ".", skipLines: 0, hasHeader: true });
    expect(t.rowCount).toBe(5);
    expect(Array.from(t.columns[1]!)).toEqual([2, NaN, NaN, NaN, 10]);
    expect(t.issues.map((i) => [i.line, i.kind])).toEqual([
      [3, "missing"], [4, "non-numeric"], [5, "too-few-fields"], [5, "missing"], [6, "too-many-fields"],
    ]);
    expect(t.columnIssueCounts).toEqual([0, 3]);
    expect(t.rowsWithIssues).toBe(4);
  });

  it("text columns are not read as signals", () => {
    const text = "label,value\nA,1\nB,2\n";
    const t = parseDelimited(text, optionsOf(text));
    expect(t.kinds).toEqual(["text", "number"]);
    expect(t.columns[0]).toBeNull();
  });

  it("ISO timestamps keep sub-millisecond resolution relative to the first row", () => {
    expect(parseIsoDateTime("2026-03-01T10:00:00.000125Z")).toEqual({ sec: Date.UTC(2026, 2, 1, 10) / 1000, frac: 0.000125 });
    // 4 kHz for 2 s: crosses a whole-second boundary at 23:59:59.
    const rows = Array.from({ length: 8000 }, (_, n) => {
      const us = n * 250;
      const s = Math.floor(us / 1e6);
      return `2026-03-01 23:59:${String(58 + s).padStart(2, "0")}.${String(us % 1e6).padStart(6, "0")},${n}`;
    });
    const text = `time,x\n${rows.join("\n")}\n`;
    const t = parseDelimited(text, optionsOf(text));
    expect(t.kinds[0]).toBe("datetime");
    expect(t.timeOrigins[0]).toBe("2026-03-01 23:59:58.000000");
    const d = analyzeTimestamps(t.columns[0]!);
    expect(d.quality).toBe("uniform-within-policy");
    expect(d.sampleRateFromFitHz!).toBeCloseTo(4000, 6);
    const zoned = parseDelimited("t,x\n2026-03-01T23:59:59.5+01:00,1\n2026-03-02T00:00:00.5+01:00,2\n", {
      delimiter: ",", decimal: ".", skipLines: 0, hasHeader: true,
    });
    expect(Array.from(zoned.columns[0]!)).toEqual([0, 1]);
  });

  it("time-of-day columns", () => {
    const t = parseDelimited("t,x\n12:00:00.000,1\n12:00:00.010,2\n12:00:00.020,3\n", { delimiter: ",", decimal: ".", skipLines: 0, hasHeader: true });
    expect(t.kinds[0]).toBe("time-of-day");
    expect(Array.from(t.columns[0]!).map((v) => Math.round(v * 1e6))).toEqual([0, 10000, 20000]);
  });

  it("chunk boundaries anywhere give the same table", () => {
    const text = repoFile("examples/acceleration-with-time.csv").slice(0, 20000);
    const whole = parseDelimited(text, optionsOf(text));
    const parser = new DelimitedParser(optionsOf(text));
    let i = 0;
    let step = 1;
    while (i < text.length) {
      parser.push(text.slice(i, i + step));
      i += step;
      step = (step * 7 + 3) % 97 + 1;
    }
    const chunked = parser.finish();
    expect(chunked.rowCount).toBe(whole.rowCount);
    for (let c = 0; c < whole.columns.length; c++) expect(Array.from(chunked.columns[c]!)).toEqual(Array.from(whole.columns[c]!));
  });
});

describe("bundled examples", () => {
  it("acceleration-with-time.csv: 8192 rows, exact 1024 Hz timestamps", () => {
    const text = repoFile("examples/acceleration-with-time.csv");
    const t = parseDelimited(text, optionsOf(text));
    expect(t.names).toEqual(["time_s", "ax_g", "ay_g", "az_g"]);
    expect(t.rowCount).toBe(8192);
    expect(t.issueCount).toBe(0);
    const time = t.columns[0]!;
    for (let n = 0; n < 8192; n++) expect(time[n]).toBe(n / 1024);
    expect(analyzeTimestamps(time).sampleRateFromFitHz!).toBeCloseTo(1024, 9);
  });

  it("acceleration-raw.csv is the same data without the time column", () => {
    const withTime = repoFile("examples/acceleration-with-time.csv");
    const raw = repoFile("examples/acceleration-raw.csv");
    const derived = withTime.split("\n").map((line) => line.slice(line.indexOf(",") + 1)).join("\n");
    expect(derived).toBe(raw);
  });
});

describe("CSV export text", () => {
  it("neutralises spreadsheet formulas and quotes separators", () => {
    expect(csvText("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvText("-x")).toBe("'-x");
    expect(csvText('a,"b"')).toBe('"a,""b"""');
    expect(csvText("ax_g")).toBe("ax_g");
  });
});
