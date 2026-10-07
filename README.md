# Tower Bloxx × Laya

A browser page that runs Tower Bloxx (Digital Chocolate, J2ME) in the [freej2me-web](https://github.com/zb3/freej2me-web) emulator and lets an agent decide when to drop each block: it reads the game canvas, predicts where the swinging block would land, and presses the drop key. The decider is either a heuristic or [Laya](https://github.com/NandhaKishorM/laya) (through `laya-ts`, in a Web Worker), with the heuristic standing in whenever Laya is too slow or unsure. You can take control back at any moment by pressing a key.

Everything runs in one Chrome tab: no Java, no Python at runtime, no inference service.

## Status

| Milestone | State |
|---|---|
| M0 feasibility spike (`spike.html`) | done: game library persists, user and synthetic keys reach the game, Laya runs on WebGPU (~1.2 s per decision on an Intel Mac) |
| M1 perception, prediction, prompt, players, input router | done, unit-tested |
| M2 calibration, timing, live overlay | built; accuracy check on the real game pending |
| M3 agent mode, takeover, outcomes, stats | built; live check pending |
| M4 Laya as the decider, heuristic fallback | built; live check pending |
| M5 bench (random / heuristic / Laya), JSONL and CSV downloads | not started |

## Requirements

- Chrome or Edge, current. WebGPU is used for Laya when available (`chrome://gpu`), WASM otherwise.
- Node 24 and npm, for building, testing and serving.
- Conda, only for the one-time model export.
- An internet connection: the emulator's Java runtime (CheerpJ) loads from a CDN.
- Your own copy of Tower Bloxx as a `.jar`. It is not included and nothing here downloads it.

## Setup

```bash
npm install
npm start            # fetches the emulator into vendor/ on first run, serves http://localhost:5180/
```

The port is fixed on purpose: the emulator keeps its game library in browser storage for that exact origin. On another host or port you upload the game again.

### Laya model (for the Laya player and the spike's Laya check)

No ready-made split ONNX export of Laya is published, so export it once (~850 MB download, ~1.7 GB output):

```bash
conda env create -f environment.yml          # once
npm run get-model                            # writes public/models/laya/
LAYA_CONDA_ENV=myenv npm run get-model       # to use another env with the same packages
```

`laya-ts` is not on npm yet; `vendor/laya-ts-0.1.0-a4a8921.tgz` is built from a pinned commit by `npm run build-laya-ts`.

## Using it

1. **Add the game.** Open http://localhost:5180/. The left pane shows the emulator's library: add your `.jar` and click it. The app remembers it and launches it directly next time.
2. **Calibrate** (once per setup). Start a round. With a block hanging, click **Freeze frame**, then:
   - tool **sky**: click plain sky in 3–5 places;
   - tool **block**: drag a tight box around the hanging block;
   - tool **tower top**: drag a box around the top block of the tower.

   The frozen frame should show a red box on the block and a green one on the tower top; adjust **sky tol** / **max score** if not. If detection drops out as the tower grows, freeze again and add another sample. **Export JSON** backs the calibration up.
3. **Timing.** Play a few drops with **5** and click **Test drop** a few times. With **auto-tune** on, fall time, key delays and carry are refitted from where blocks actually land after every drop. The sliders override them; the accuracy line and the table's "err now" column re-score past drops with the current settings.
4. **Agent.** Press `` ` `` or **Start agent**. Any other key pauses it (takeover) and still reaches the game; `` ` `` or **Resume** gives control back.
5. **Laya.** Click **Load model** (~25 s; ~1.7 GB on first load, cached after), then pick **laya** as the player. Each decision Laya answers drop/wait for the same question the heuristic sees. The heuristic decides instead when Laya is still busy, answers after its deadline (expected latency + **deadline slack**), errors, returns something else, or its `answer_confidence` is below **min confidence**. The stats table shows the fallback rate and Laya's latency; the Laya panel splits fallbacks by reason and shows the first raw answer.

The panel is mouse-only: the emulator pulls keyboard focus back to the game.

## How it works

Each tick (30 fps by default) the page reads the emulator canvas and finds the hanging block and the tower top by template matching: coarse search on 4×4-pooled images with sky windows skipped, refined at full resolution. The block's swing and the tower's sway are fitted as sine waves and projected ahead by the key delay, the decider's own latency and the fall time, giving "if dropped now, it lands N px left of the tower center". Every player sees that as one choice question, `drop` or `wait`. At most one decision is in flight; an answer that arrives after its deadline is discarded, and one that arrives early waits for the moment its prediction was made for. A tracker follows each drop from key to landing or miss, which feeds timing, outcomes and stats.

## Layout

```
src/        perception, predictor, prompt, players, input (router), loop (vision, drops, agent, stats),
            calibrate, storage (IndexedDB, JSON), emulator, capture, ui, main, laya.worker
tests/      Vitest, Node only; synth.ts draws synthetic scenes and drops with known ground truth
scripts/    get-emulator, get-model, build-laya-ts, make-fixtures (PNG previews of the test scenes)
spike.html  the M0 feasibility page
```

## Tests

```bash
npm test         # Node only, no browser or model needed
npm run build    # type check + production build
```

## Known limits

- The swing model assumes a sine-like pendulum; it is exact on synthetic scenes and still being checked against the real game.
- Laya currently takes ~1.2 s per decision on an Intel Mac with WebGPU, so it has to predict far ahead; late answers are dropped.
- Without internet, or if CheerpJ is slow, the emulator will not load or will run slowly.
- The drop key depends on the emulated phone type: `5` on the default (Nokia) type, configurable in Settings.

## Licenses

- This project: no license file yet.
- freej2me-web (downloaded into `vendor/freej2me-web/`, with its LICENSE): GPL-3.0.
- Laya and laya-ts: Apache-2.0.
