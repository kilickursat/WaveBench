import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export interface TooltipRow {
  color?: string;
  label: string;
  value: string;
}

/** Floating tooltip near the cursor. Rows are set as text (labels come from imported files). */
export function tooltipPlugin(rows: (u: uPlot, idx: number | null, left: number, top: number) => { title: string; rows: TooltipRow[] } | null): uPlot.Plugin {
  let box: HTMLDivElement | null = null;
  return {
    hooks: {
      init: (u) => {
        box = document.createElement("div");
        box.className = "tooltip";
        box.style.display = "none";
        u.over.appendChild(box);
        u.over.addEventListener("mouseleave", () => {
          if (box) box.style.display = "none";
        });
      },
      setCursor: (u) => {
        if (!box) return;
        const { left, top, idx } = u.cursor;
        if (left === undefined || top === undefined || left < 0 || top < 0) {
          box.style.display = "none";
          return;
        }
        const content = rows(u, idx ?? null, left, top);
        if (!content) {
          box.style.display = "none";
          return;
        }
        box.replaceChildren();
        const head = document.createElement("div");
        head.className = "muted";
        head.textContent = content.title;
        box.appendChild(head);
        for (const r of content.rows) {
          const line = document.createElement("div");
          if (r.color) {
            const key = document.createElement("i");
            key.style.background = r.color;
            line.appendChild(key);
          }
          const text = document.createElement("span");
          text.textContent = `${r.label} ${r.value}`;
          line.appendChild(text);
          box.appendChild(line);
        }
        box.style.display = "block";
        const w = box.offsetWidth;
        const h = box.offsetHeight;
        const ow = u.over.clientWidth;
        const oh = u.over.clientHeight;
        box.style.left = `${left + 14 + w > ow ? left - w - 14 : left + 14}px`;
        box.style.top = `${Math.max(0, Math.min(top + 12, oh - h))}px`;
      },
    },
  };
}

/** Zoom the x scale around the cursor with the mouse wheel. */
export function wheelZoomPlugin(onZoom: (min: number, max: number) => void, limits?: () => [number, number]): uPlot.Plugin {
  return {
    hooks: {
      ready: (u) => {
        u.over.addEventListener(
          "wheel",
          (e) => {
            e.preventDefault();
            const { min, max } = u.scales.x;
            if (min === undefined || max === undefined || min === null || max === null) return;
            const at = u.posToVal(u.cursor.left ?? u.over.clientWidth / 2, "x");
            const f = e.deltaY < 0 ? 0.8 : 1.25;
            let lo = at - (at - min) * f;
            let hi = at + (max - at) * f;
            if (limits) {
              const [a, b] = limits();
              if (hi - lo >= b - a) [lo, hi] = [a, b];
              else if (lo < a) [lo, hi] = [a, a + (hi - lo)];
              else if (hi > b) [lo, hi] = [b - (hi - lo), b];
            }
            onZoom(lo, hi);
          },
          { passive: false },
        );
      },
    },
  };
}

/** Drag on the plot: zoom, or with Shift held, report a range (e.g. the analysis interval). */
export function selectPlugin(onZoom: (min: number, max: number) => void, onShiftSelect?: (min: number, max: number) => void, onReset?: () => void): uPlot.Plugin {
  let shift = false;
  return {
    hooks: {
      ready: (u) => {
        u.over.addEventListener("mousedown", (e) => (shift = e.shiftKey));
        u.over.addEventListener("dblclick", () => onReset?.());
      },
      setSelect: (u) => {
        const { left, width } = u.select;
        if (width < 3) return;
        const a = u.posToVal(left, "x");
        const b = u.posToVal(left + width, "x");
        u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
        if (shift && onShiftSelect) onShiftSelect(Math.min(a, b), Math.max(a, b));
        else onZoom(Math.min(a, b), Math.max(a, b));
      },
    },
  };
}

export function UPlotChart({ options, data, onReady, className }: { options: Omit<uPlot.Options, "width" | "height">; data: uPlot.AlignedData; onReady?: (u: uPlot | null) => void; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const latest = useRef(data);
  latest.current = data;
  useEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    const u = new uPlot({ ...options, width: Math.max(80, Math.floor(r.width)), height: Math.max(60, Math.floor(r.height)) } as uPlot.Options, latest.current, el);
    plot.current = u;
    onReady?.(u);
    const ro = new ResizeObserver(() => {
      const b = el.getBoundingClientRect();
      if (b.width > 0 && b.height > 0) u.setSize({ width: Math.floor(b.width), height: Math.floor(b.height) });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      onReady?.(null);
      u.destroy();
      plot.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);
  useEffect(() => {
    const u = plot.current;
    if (u && u.data !== data) u.setData(data, true);
  }, [data]);
  return <div className={`chart ${className ?? ""}`} ref={ref} />;
}

/** Shade x ranges under the series (drawn on the plot canvas before the lines). */
export function shade(u: uPlot, ranges: { from: number; to: number; color: string }[]): void {
  const { ctx } = u;
  const { top, height } = u.bbox;
  ctx.save();
  for (const r of ranges) {
    const a = u.valToPos(r.from, "x", true);
    const b = u.valToPos(r.to, "x", true);
    const x0 = Math.max(u.bbox.left, Math.min(a, b));
    const x1 = Math.min(u.bbox.left + u.bbox.width, Math.max(a, b));
    if (x1 <= x0) continue;
    ctx.fillStyle = r.color;
    ctx.fillRect(x0, top, Math.max(1, x1 - x0), height);
  }
  ctx.restore();
}

/** uPlot needs null, not NaN, for gaps. */
export function withGaps(values: Float64Array): ArrayLike<number | null> {
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== values[i]) return Array.from(values, (v) => (v === v ? v : null));
  }
  return values;
}
