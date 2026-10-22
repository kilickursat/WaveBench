import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { engine, EngineError } from "../engine/client";
import type { Request } from "../engine/protocol";
import { useApp } from "../state/store";

export interface EngineState<T> {
  data: T | null;
  /** Key of the request that produced `data`. */
  dataKey: string | null;
  error: string | null;
  running: boolean;
  progress: number | null;
  /** The shown result belongs to older settings (a newer one is on its way). */
  stale: boolean;
}

/**
 * Run `request` whenever its content changes (debounced). A newer request cancels the older one; the previous
 * result stays visible, marked stale, until the new one arrives (no flash of empty plots).
 */
export function useEngine<T>(request: Request | null, debounceMs = 120): EngineState<T> {
  const key = request ? JSON.stringify(request) : null;
  const [state, setState] = useState<Omit<EngineState<T>, "stale">>({ data: null, dataKey: null, error: null, running: false, progress: null });
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    if (!key || !requestRef.current) {
      setState({ data: null, dataKey: null, error: null, running: false, progress: null });
      return;
    }
    let id: number | null = null;
    let alive = true;
    const timer = setTimeout(() => {
      setState((s) => ({ ...s, running: true, progress: null, error: null }));
      const call = engine.request<T>(requestRef.current!, { onProgress: (f) => alive && setState((s) => ({ ...s, progress: f })) });
      id = call.id;
      call.promise.then(
        (data) => alive && setState({ data, dataKey: key, error: null, running: false, progress: null }),
        (e: EngineError) => {
          if (!alive || e.code === "CANCELLED") return;
          setState((s) => ({ ...s, error: e.message, running: false, progress: null, dataKey: key, data: null }));
        },
      );
    }, debounceMs);
    return () => {
      alive = false;
      clearTimeout(timer);
      if (id !== null) engine.cancel(id);
    };
  }, [key, debounceMs]);
  return { ...state, stale: state.dataKey !== key && state.data !== null };
}

const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function subscribeMedia(cb: () => void): () => void {
  media?.addEventListener("change", cb);
  return () => media?.removeEventListener("change", cb);
}

/** True when the dark theme is in effect (explicit choice or the system setting). */
export function useDark(): boolean {
  const theme = useApp((s) => s.theme);
  const systemDark = useSyncExternalStore(subscribeMedia, () => !!media?.matches);
  return theme === "dark" || (theme === "system" && systemDark);
}

/** Size of an element in CSS pixels. */
export function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize((s) => (s.width === Math.round(r.width) && s.height === Math.round(r.height) ? s : { width: Math.round(r.width), height: Math.round(r.height) }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}
