// The self-hosted freej2me-web in a same-origin iframe: launch from its library, find its canvas, press keys.
// Facts from the M0 spike and freej2me-web's web/src/main.js:
// - the game library lives in CheerpJ's IndexedDB-backed /files/apps.list for this origin;
// - run.html?app=<id> launches a stored game; the launcher links to run?app=<id>;
// - keys are read from keydown/keyup on canvas#display by `code` (key.js codeMap), isTrusted is not checked;
// - Tower Bloxx drops on Digit5 with the default (Nokia) phone type; Enter and ArrowUp do nothing.

export const DEFAULT_DROP_KEY = "Digit5";
const APP_KEY = "tbl.appId";

const KEYS: Record<string, [key: string, keyCode: number]> = {
  Digit5: ["5", 53],
  Enter: ["Enter", 13],
  ArrowUp: ["ArrowUp", 38],
  ArrowDown: ["ArrowDown", 40],
  ArrowLeft: ["ArrowLeft", 37],
  ArrowRight: ["ArrowRight", 39],
};

type FrameWindow = Window & typeof globalThis & { cjFileBlob?: (path: string) => Promise<Blob | null> };

export class Emulator {
  constructor(readonly frame: HTMLIFrameElement) {}

  get window(): FrameWindow | null {
    return this.frame.contentWindow as FrameWindow | null;
  }

  /** The game canvas, once a game is running. */
  get canvas(): HTMLCanvasElement | null {
    const c = this.window?.document.getElementById("display") as HTMLCanvasElement | null;
    return c && c.width > 0 && c.style.display !== "none" ? c : null;
  }

  get storedAppId(): string | null {
    return localStorage.getItem(APP_KEY);
  }

  /** The app id in the frame's URL, remembered so the next visit can launch it directly. */
  syncAppId(): string | null {
    const app = new URLSearchParams(this.window?.location.search ?? "").get("app");
    if (app && app !== this.storedAppId) localStorage.setItem(APP_KEY, app);
    return app;
  }

  openLibrary() {
    this.frame.src = "/emu/";
  }

  launch(appId = this.storedAppId): boolean {
    if (!appId) return false;
    this.frame.src = `/emu/run.html?app=${encodeURIComponent(appId)}`;
    return true;
  }

  /** Dispatch one keydown or keyup on the game canvas, the element freej2me-web listens on. */
  dispatch(type: "keydown" | "keyup", code: string, key?: string): boolean {
    const w = this.window;
    const c = this.canvas;
    if (!w || !c) return false;
    const [k, keyCode] = KEYS[code] ?? [key ?? code, 0];
    const ev = new w.KeyboardEvent(type, { key: k, code, bubbles: true, cancelable: true });
    // keyCode / which can't be set through the init dict in Chrome.
    Object.defineProperty(ev, "keyCode", { get: () => keyCode });
    Object.defineProperty(ev, "which", { get: () => keyCode });
    c.dispatchEvent(ev);
    return ev.defaultPrevented; // the emulator's handler cancels every key it takes
  }

  /** Press and release; resolves after the release. */
  async press(code: string, holdMs = 60): Promise<boolean> {
    const down = this.dispatch("keydown", code);
    await new Promise((r) => setTimeout(r, holdMs));
    this.dispatch("keyup", code);
    return down;
  }
}
