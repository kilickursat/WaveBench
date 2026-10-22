import { useSyncExternalStore } from "react";
import { initialState, type AppState } from "./model";

type Listener = () => void;

let state: AppState = initialState();
const listeners = new Set<Listener>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Select a value; return existing references or primitives so the snapshot stays stable. */
export function useApp<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

let noticeId = 0;

export function notify(kind: "error" | "warning" | "info", text: string): void {
  const id = ++noticeId;
  setState((s) => ({ notices: [...s.notices.filter((n) => n.text !== text), { id, kind, text }].slice(-4) }));
  if (kind !== "error") setTimeout(() => dismiss(id), 8000);
}

export function dismiss(id: number): void {
  setState((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
}
