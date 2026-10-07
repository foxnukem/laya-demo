import { defineConfig, type Plugin } from "vite";
import sirv from "sirv";

// One fixed origin: freej2me-web keeps its game library in IndexedDB for this origin only.
const PORT = 5180;

// Self-hosted freej2me-web under /emu/. sirv answers Range requests (CheerpJ needs them);
// /emu/run is mapped to run.html because the emulator's launcher links to `run?app=...`.
function emulator(): Plugin {
  const serve = sirv("vendor/freej2me-web/web", { dev: true, etag: true });
  const mount = (mw: { use: Function }) =>
    mw.use("/emu", (req: any, res: any, next: () => void) => {
      if (req.url === "/" || req.url === "") req.url = "/index.html";
      req.url = req.url.replace(/^\/run(\?|$)/, "/run.html$1");
      serve(req, res, next);
    });
  return {
    name: "freej2me-web",
    configureServer: (s) => void mount(s.middlewares),
    configurePreviewServer: (s) => void mount(s.middlewares),
  };
}

// laya-ts imports onnxruntime-web through a computed specifier ("onnxruntime-" + "web") that only
// resolves through an import map, and import maps do not apply inside Web Workers. Rewrite it to a
// literal so Vite resolves it. Fails the build if laya-ts changes, rather than breaking at runtime.
function layaOrtSpecifier(): Plugin {
  return {
    name: "laya-ort-specifier",
    enforce: "pre",
    transform(code, id) {
      if (!/laya-ts[\\/]dist[\\/]providers\.js(\?|$)/.test(id)) return;
      const from = 'const spec = "onnxruntime-" + "web";\n    const ort = await import(/* @vite-ignore */ spec);';
      if (!code.includes(from)) this.error("laya-ts providers.js changed; update layaOrtSpecifier()");
      return code.replace(from, 'const ort = await import("onnxruntime-web");');
    },
  };
}

export default defineConfig({
  plugins: [emulator(), layaOrtSpecifier()],
  server: { port: PORT, strictPort: true },
  preview: { port: PORT, strictPort: true },
  // Served as-is so ort finds its .wasm next to itself and the laya-ts transform applies.
  optimizeDeps: { exclude: ["onnxruntime-web", "laya-ts"] },
  worker: { format: "es", plugins: () => [layaOrtSpecifier()] },
  build: {
    target: "es2022",
    rollupOptions: { input: { main: "index.html", spike: "spike.html" } },
  },
});
