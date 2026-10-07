// Input router as a pure state machine: the DOM layer feeds key events in and carries out the returned delivery.
// The user's keys always reach the game; the only key ever withheld is the reserved hotkey.

export type Mode = "manual" | "agent" | "paused";

export interface KeyIn {
  type: "keydown" | "keyup";
  code: string; // KeyboardEvent.code
  origin: "game" | "page"; // focus inside the emulator frame, or elsewhere on our page
  editable?: boolean; // typed into a text field / slider of our own panel
  repeat?: boolean;
}

export interface RouterConfig {
  hotkey: string; // starts / stops / resumes the agent, never forwarded
  dropKey: string;
}

export const DEFAULT_ROUTER: RouterConfig = { hotkey: "Backquote", dropKey: "Digit5" };

/**
 * native: already on its way to the game, leave it alone.
 * redispatch: pressed with focus on our page; copy it onto the emulator canvas.
 * block: the hotkey; stop it before the emulator sees it.
 * ignore: meant for our own panel controls.
 */
export type Delivery = "native" | "redispatch" | "block" | "ignore";

export type Effect =
  | { kind: "mode"; from: Mode; to: Mode; reason: "hotkey" | "takeover" | "button" }
  | { kind: "userDrop" };

export interface Routed {
  mode: Mode;
  delivery: Delivery;
  effects: Effect[];
}

const change = (from: Mode, to: Mode, reason: "hotkey" | "takeover" | "button"): Effect[] =>
  from === to ? [] : [{ kind: "mode", from, to, reason }];

export function routeKey(mode: Mode, e: KeyIn, cfg: RouterConfig = DEFAULT_ROUTER): Routed {
  if (e.origin === "page" && e.editable) return { mode, delivery: "ignore", effects: [] };

  if (e.code === cfg.hotkey) {
    if (e.type !== "keydown" || e.repeat) return { mode, delivery: "block", effects: [] };
    const to: Mode = mode === "agent" ? "manual" : "agent";
    return { mode: to, delivery: "block", effects: change(mode, to, "hotkey") };
  }

  const delivery: Delivery = e.origin === "game" ? "native" : "redispatch";
  if (e.type !== "keydown" || e.repeat) return { mode, delivery, effects: [] };

  const effects: Effect[] = [];
  let to = mode;
  if (mode === "agent") {
    to = "paused";
    effects.push(...change(mode, to, "takeover"));
  }
  if (e.code === cfg.dropKey) effects.push({ kind: "userDrop" });
  return { mode: to, delivery, effects };
}

/** Panel buttons: Start / Stop / Resume. */
export function setMode(mode: Mode, to: Mode): Routed {
  return { mode: to, delivery: "ignore", effects: change(mode, to, "button") };
}

/** The agent may press the drop key only while it is in control. */
export const agentMayAct = (mode: Mode) => mode === "agent";
