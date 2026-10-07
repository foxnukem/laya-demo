// Laya inference off the main thread, so a slow forward pass never stalls the emulator.
import * as ort from "onnxruntime-web";
import { Agent, type QuestionDef, type SystemOneResult } from "laya-ts";

export type Backend = "webgpu" | "wasm" | "wasm (webgpu failed at run time)";

export type WorkerRequest =
  | { type: "load"; url: string }
  | { type: "predict"; id: number; state: unknown; questions: Record<string, QuestionDef> };

export type WorkerResponse =
  | { type: "progress"; file: string; done: number; total: number }
  | { type: "loaded"; ms: number; backend: Backend }
  | { type: "answer"; id: number; ms: number; result: SystemOneResult; backend: Backend }
  | { type: "error"; id?: number; message: string };

let agent: Agent | null = null;
let backend: Backend = "wasm";

// laya-ts picks its browser path with `typeof window !== "undefined"`, which is false in a worker.
// ort is already evaluated above, so the shim only steers Agent.load.
(globalThis as any).window ??= globalThis;

// laya-ts falls back from WebGPU silently; watch the session options and its run-time warning.
const create = ort.InferenceSession.create.bind(ort.InferenceSession);
(ort.InferenceSession as any).create = async (...args: any[]) => {
  const session = await (create as any)(...args);
  const eps: string[] = (args[1]?.executionProviders ?? []).map(String);
  if (eps[0] === "webgpu" && (ort.env as any).webgpu?.adapter) backend = "webgpu";
  return session;
};
const warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (String(args[0]).includes("WebGPU encoder run failed")) backend = "wasm (webgpu failed at run time)";
  warn(...args);
};

const post = (msg: WorkerResponse) => (self as unknown as Worker).postMessage(msg);

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
      const t0 = performance.now();
      agent = await Agent.load(msg.url, {
        onProgress: (done, total, file) => post({ type: "progress", file, done, total }),
      });
      post({ type: "loaded", ms: performance.now() - t0, backend });
    } else if (msg.type === "predict") {
      if (!agent) throw new Error("model not loaded");
      const t0 = performance.now();
      const result = await agent.predict(msg.state as any, msg.questions);
      post({ type: "answer", id: msg.id, ms: performance.now() - t0, result, backend });
    }
  } catch (err) {
    post({ type: "error", id: (msg as any).id, message: String((err as Error)?.stack ?? err) });
  }
};
