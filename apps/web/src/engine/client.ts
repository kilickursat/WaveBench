import EngineWorker from "./worker?worker&inline";
import type { Envelope, Reply, Request } from "./protocol";

export class EngineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: EngineError) => void;
  onProgress?: (fraction: number, label?: string) => void;
  onEvent?: (event: unknown) => void;
}

export interface CallOptions {
  transfer?: Transferable[];
  onProgress?: (fraction: number, label?: string) => void;
  onEvent?: (event: unknown) => void;
}

/** Promise-based requests to the engine worker. */
export class EngineClient {
  private readonly worker: Worker;
  private next = 1;
  private readonly pending = new Map<number, Pending>();

  constructor() {
    this.worker = new EngineWorker();
    this.worker.onmessage = (e: MessageEvent<Reply>) => {
      const reply = e.data;
      const p = this.pending.get(reply.id);
      if (!p) return;
      if (reply.kind === "progress") p.onProgress?.(reply.fraction, reply.label);
      else if (reply.kind === "event") p.onEvent?.(reply.event);
      else {
        this.pending.delete(reply.id);
        if (reply.kind === "done") p.resolve(reply.result);
        else p.reject(new EngineError(reply.code, reply.message));
      }
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new EngineError("WORKER_ERROR", e.message || "the engine stopped"));
      this.pending.clear();
    };
  }

  request<T>(request: Request, options: CallOptions = {}): { id: number; promise: Promise<T> } {
    const id = this.next++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress: options.onProgress, onEvent: options.onEvent });
    });
    const envelope: Envelope = { id, request };
    this.worker.postMessage(envelope, options.transfer ?? []);
    return { id, promise };
  }

  call<T>(request: Request, options: CallOptions = {}): Promise<T> {
    return this.request<T>(request, options).promise;
  }

  cancel(id: number): void {
    this.worker.postMessage({ id: this.next++, request: { type: "cancel", target: id } } satisfies Envelope);
  }
}

export const engine = new EngineClient();
