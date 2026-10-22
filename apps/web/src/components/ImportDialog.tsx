import { useEffect, useState } from "react";
import { DELIMITERS, sniffDelimited, UNITS, type Delimiter } from "@wavebench/core";
import { confirmImport, importProblem } from "../state/actions";
import { setState, useApp } from "../state/store";
import type { ColumnRole, ImportDraft } from "../state/model";
import type { TimeUnit } from "../engine/protocol";
import { int } from "../lib/format";
import { Modal, Select } from "./ui";

const DELIMITER_LABELS: Record<Delimiter, string> = { ",": "Comma", ";": "Semicolon", "\t": "Tab", "|": "Vertical bar", whitespace: "Spaces" };

export function ImportDialog() {
  const draft = useApp((s) => s.importDraft);
  if (!draft) return null;
  return <ImportForm key={draft.name + draft.sniff.bytes} initial={draft} />;
}

function ImportForm({ initial }: { initial: ImportDraft }) {
  const [d, setD] = useState(initial);
  const [sample, setSample] = useState<string | null>(initial.text ? initial.text.slice(0, 256 * 1024) : null);
  useEffect(() => {
    if (initial.file) void initial.file.slice(0, 256 * 1024).text().then(setSample);
  }, [initial.file]);

  // Re-read the preview with changed format options (the sniffer only proposes them).
  const reparse = (patch: Partial<ImportDraft["options"]>) => {
    const options = { ...d.options, ...patch };
    if (!sample) {
      setD({ ...d, options });
      return;
    }
    try {
      const lines = sample.replace(/^﻿/, "").split(/\r\n|\n|\r/);
      const forced = sniffDelimited(lines.slice(options.skipLines).join("\n"));
      setD({
        ...d,
        options: { ...options, columnKinds: forced.columnKinds, columnNames: options.hasHeader ? undefined : forced.columnNames },
        sniff: { ...d.sniff, ...forced, delimiter: options.delimiter, skipLines: options.skipLines },
        roles: forced.columnKinds.map((k, i) => d.roles[i] ?? (k === "number" ? "signal" : "ignore")),
      });
    } catch {
      setD({ ...d, options });
    }
  };

  const { sniff, roles } = d;
  const problem = importProblem(d);
  const timeIndex = roles.indexOf("time");
  const timeKind = timeIndex >= 0 ? sniff.columnKinds[timeIndex] : null;
  const setRole = (i: number, role: ColumnRole) => {
    const next = roles.map((r, j) => (j === i ? role : role === "time" && r === "time" ? "signal" : r));
    setD({ ...d, roles: next });
  };
  const close = () => setState({ importDraft: null });
  return (
    <Modal
      title={`Import ${d.name}`}
      onClose={close}
      footer={
        <>
          <span className="problem">{problem}</span>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!!problem} onClick={() => void confirmImport(d)}>
            Import
          </button>
        </>
      }
    >
      <div className="form-row">
        <label>
          Delimiter
          <Select<Delimiter> value={d.options.delimiter} options={DELIMITERS.map((v) => ({ value: v, label: DELIMITER_LABELS[v] }))} onChange={(v) => reparse({ delimiter: v })} />
        </label>
        <label>
          Decimal mark
          <Select value={d.options.decimal} options={[{ value: ".", label: "Point (1.5)" }, { value: ",", label: "Comma (1,5)", disabled: d.options.delimiter === "," }]} onChange={(v) => reparse({ decimal: v })} />
        </label>
        <label>
          Lines to skip
          <input className="input" type="number" min={0} value={d.options.skipLines} onChange={(e) => reparse({ skipLines: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
        </label>
        <label>
          First line
          <Select value={d.options.hasHeader ? "header" : "data"} options={[{ value: "header", label: "Column names" }, { value: "data", label: "Data" }]} onChange={(v) => reparse({ hasHeader: v === "header" })} />
        </label>
      </div>
      {sniff.metadataLines.length > 0 && (
        <p className="hint">
          Skipped lines before the table: {sniff.metadataLines.slice(0, 3).map((l) => `“${l.slice(0, 60)}”`).join(", ")}
          {sniff.metadataLines.length > 3 ? " …" : ""}
        </p>
      )}
      <div className="preview">
        <table className="grid">
          <thead>
            <tr>
              <th>Line</th>
              {sniff.columnNames.map((n, i) => (
                <th key={i} className={roles[i] === "time" ? "role-time" : ""}>
                  <div style={{ color: "var(--ink)", marginBottom: 4 }}>{n}</div>
                  <Select<ColumnRole>
                    ariaLabel={`Role of ${n}`}
                    value={roles[i]}
                    options={[
                      { value: "signal", label: "Signal", disabled: sniff.columnKinds[i] !== "number" },
                      { value: "time", label: "Time", disabled: sniff.columnKinds[i] === "text" || sniff.columnKinds[i] === "empty" },
                      { value: "ignore", label: "Ignore" },
                    ]}
                    onChange={(v) => setRole(i, v)}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sniff.preview.map((row, r) => (
              <tr key={r}>
                <td>{sniff.previewLines[r]}</td>
                {row.map((cell, c) => (
                  <td key={c} className={roles[c] === "ignore" ? "role-ignore" : roles[c] === "time" ? "role-time" : ""}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="form-row" style={{ marginTop: 14 }}>
        <label>
          Signal unit
          <Select value={d.unit} options={UNITS.map((u) => ({ value: u.id, label: u.label }))} onChange={(v) => setD({ ...d, unit: v })} />
        </label>
        {timeIndex >= 0 ? (
          timeKind === "datetime" || timeKind === "time-of-day" ? (
            <label>
              Time column
              <span className="input" style={{ display: "flex", alignItems: "center" }}>
                {timeKind === "datetime" ? "date-time (ISO 8601)" : "time of day"}
              </span>
            </label>
          ) : (
            <label>
              Time column unit
              <Select<TimeUnit> value={d.timeUnit} options={[{ value: "s", label: "seconds" }, { value: "ms", label: "milliseconds" }, { value: "us", label: "microseconds" }, { value: "ns", label: "nanoseconds" }]} onChange={(v) => setD({ ...d, timeUnit: v })} />
            </label>
          )
        ) : (
          <>
            <label>
              Sampling rate (Hz)
              <input className={`input ${d.rate && !(Number(d.rate) > 0) ? "invalid" : ""}`} inputMode="decimal" placeholder="required" value={d.rate} onChange={(e) => setD({ ...d, rate: e.target.value })} />
            </label>
            <label>
              Start time (s)
              <input className="input" inputMode="decimal" value={d.start} onChange={(e) => setD({ ...d, start: e.target.value })} />
            </label>
          </>
        )}
      </div>
      <p className="hint">
        {timeIndex >= 0
          ? "The timestamps are checked for order, gaps and jitter after import; the sampling rate is fitted to them."
          : "Without a time column, the time of sample n is start + n / fs. The values alone cannot tell the sampling rate."}{" "}
        {d.unit === "count" || d.unit === "V" || d.unit === "mV" || d.unit === "unknown"
          ? "Raw units stay labelled as such; a calibration (offset and gain) can be set per channel after import."
          : ""}
        {sniff.bytes ? ` File size ${int(sniff.bytes / 1024)} KiB.` : ""}
      </p>
    </Modal>
  );
}
