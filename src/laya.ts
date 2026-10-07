// Page side of the Laya worker: load once, warm up, then answer one question at a time.
import type { QuestionDef, SystemOneResult } from "laya-ts";
import type { Backend, WorkerRequest, WorkerResponse } from "./laya.worker";
import type { LayaBackend } from "./players";
import type { GameState, Questions } from "./prompt";

export interface LoadInfo {
  ms: number;
  backend: Backend;
  warmupMs: number;
  raw: SystemOneResult; // the first answer, logged as the spec asks
}

export class LayaWorker implements LayaBackend {
  backend: Backend | null = null;
  private worker: Worker;
  private nextId = 0;
  private waiting = new Map<number, { resolve: (r: { result: SystemOneResult; ms: number }) => void; reject: (e: Error) => void; t0: number }>();
  private onLoad: ((m: WorkerResponse) => void) | null = null;

  constructor(private onProgress: (text: string) => void = () => {}) {
    this.worker = new Worker(new URL("./laya.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data;
      if (m.type === "progress") return this.onProgress(`loading ${m.file} (${m.done}/${m.total})`);
      if (m.type === "loaded" || (m.type === "error" && m.id === undefined)) return this.onLoad?.(m);
      if (m.type === "answer" || m.type === "error") {
        const w = this.waiting.get(m.id!);
        if (!w) return;
        this.waiting.delete(m.id!);
        if (m.type === "error") return w.reject(new Error(m.message));
        this.backend = m.backend;
        w.resolve({ result: m.result, ms: performance.now() - w.t0 });
      }
    };
  }

  private post(m: WorkerRequest) {
    this.worker.postMessage(m);
  }

  /** Load the model and answer one sample question, so the first real decision is not a cold start. */
  async load(url: string, sample: { state: GameState; question: Questions }): Promise<LoadInfo> {
    const loaded = await new Promise<WorkerResponse>((resolve) => {
      this.onLoad = resolve;
      this.post({ type: "load", url });
    });
    this.onLoad = null;
    if (loaded.type === "error") throw new Error(loaded.message);
    if (loaded.type !== "loaded") throw new Error("unexpected worker reply");
    this.backend = loaded.backend;
    const warm = await this.ask(sample.state, sample.question);
    return { ms: loaded.ms, backend: this.backend, warmupMs: warm.ms, raw: warm.result };
  }

  ask(state: GameState, question: Questions): Promise<{ result: SystemOneResult; ms: number }> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, t0: performance.now() });
      // Questions is a typed subset of laya-ts's open QuestionDef record.
      this.post({ type: "predict", id, state, questions: question as unknown as Record<string, QuestionDef> });
    });
  }

  terminate() {
    this.worker.terminate();
  }
}
