import { useEffect, useRef, useState } from "react";
import { initGpu, openFile } from "./state/actions";
import { dismiss, setState, useApp } from "./state/store";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { GeneratorDialog } from "./components/GeneratorDialog";
import { ImportDialog } from "./components/ImportDialog";
import { Sidebar } from "./components/Sidebar";
import { TimePanel } from "./components/TimePanel";
import { TopBar } from "./components/TopBar";
import { Welcome } from "./components/Welcome";
import { percent } from "./lib/format";

export function App() {
  const theme = useApp((s) => s.theme);
  const ready = useApp((s) => !!s.configured && !!s.source);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    void initGpu();
  }, []);

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) void openFile(f);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);

  return (
    <div className={`app ${dragging ? "drop-active" : ""}`}>
      <TopBar />
      <div className="body">
        <Sidebar />
        <main className="main" onClick={() => sidebarOpen && setState({ sidebarOpen: false })}>
          {ready ? (
            <>
              <TimePanel />
              <AnalysisPanel />
            </>
          ) : (
            <Welcome onOpen={() => fileRef.current?.click()} />
          )}
        </main>
      </div>
      <input
        ref={fileRef}
        type="file"
        hidden
        accept=".csv,.tsv,.txt,.dat,.asc,text/csv,text/plain"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void openFile(f);
        }}
      />
      <ImportDialog />
      <GeneratorDialog />
      <Busy />
      <Notices />
    </div>
  );
}

function Busy() {
  const busy = useApp((s) => s.busy);
  if (!busy) return null;
  return (
    <div className="busy" role="status">
      <span>{busy.label}…</span>
      {busy.fraction !== null && <progress max={1} value={busy.fraction} aria-label={percent(busy.fraction, 2)} />}
    </div>
  );
}

function Notices() {
  const notices = useApp((s) => s.notices);
  return (
    <div className="notices" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`notice ${n.kind}`} role={n.kind === "error" ? "alert" : "status"}>
          <p>{n.text}</p>
          <button aria-label="Dismiss" onClick={() => dismiss(n.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
