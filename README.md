# Power Surge Circuit

A futuristic grid arcade game. You are the electrical surge: route yourself across
circuit boards, collect energy, extend your trail, and keep the current alive.

- **Engine:** vanilla HTML5 Canvas + ES modules. No frameworks, no build step.
- **Runtime dependencies:** none. No CDNs, no remote assets, no network calls.
- **Audio:** fully synthesised at runtime with the Web Audio API.
- **Art:** 100% procedural. There are no image files — every trace, arc, glow,
  spark and explosion is drawn with canvas primitives.
- **Offline:** works from `file://`, a local web server, or installed as a PWA.

---

## 1. Installation

### Option A — XAMPP (recommended, matches the target deployment)

1. Confirm the project is at `C:\xampp\htdocs\power-surge-circuit`.
2. Make sure Apache is running (XAMPP Control Panel, or the `Apache2.4` service).
3. This machine serves the site on **port 8080** (port 80 is used by another
   local application), so the URL is:

   **http://localhost:8080/power-surge-circuit/**

   The intended production-style hostname also resolves:

   **http://mother.local:8080/power-surge-circuit/**

> **Note:** `mother.local` must be present in `C:\Windows\System32\drivers\etc\hosts`
> (typically as `127.0.0.1  mother.local`) for that name to work from a browser.
> `http://localhost:8080/power-surge-circuit/` always works and serves the exact
> same files.

### Option B — bundled test server (no Apache required)

```powershell
cd C:\xampp\htdocs\power-surge-circuit
node tools/serve.mjs 8099
# then open http://127.0.0.1:8099/
```

### Option C — directly from disk

Open `index.html` in a modern browser. ES modules over `file://` are blocked by
Chrome and Edge, so use Option A or B for those browsers. Firefox historically
allows it; do not rely on it.

### Requirements

| Component | Minimum |
| --- | --- |
| Browser | Chrome/Edge 92+, Firefox 90+, Safari 15.4+ |
| Node.js (tests/tooling only) | 20+ — the game itself needs no Node |
| Screen | 320×568 and up; portrait and landscape both supported |

---

## 2. Controls

### Desktop

| Action | Keys |
| --- | --- |
| Steer | Arrow keys or **W A S D** |
| Pause / resume | **Space**, **Escape**, or **P** |
| Restart (from results) | on-screen buttons |

Gameplay keys call `preventDefault()`, so the page never scrolls while playing.

### Mobile

- **Swipe** to steer. Swipes are registered against a 20 px dead zone, so a tap
  never triggers a turn.
- **Tap** the board to pause or resume.
- The direction is chosen from the dominant axis, so a sloppy diagonal still
  produces a predictable 90-degree turn.
- A long continuous drag can queue one extra turn after crossing a second dead
  zone, which makes tight corners feel responsive.
- Pinch-zoom, double-tap zoom and pull-to-refresh are suppressed on the board.

### Turn queueing

Exactly one turn is held in a queue at a time. A newer valid turn replaces the
queued one, and a direct reversal of the committed direction is rejected. Pressing
the direction you are already travelling in **cancels** a queued turn, which lets
you undo a mistimed swipe.

---

## 3. How the game works

### Core rules

- The surge moves continuously on a **24 × 18** grid, one cell per tick.
- Collecting an energy node **permanently** extends the trail by one segment.
- The board **wraps** at every edge — leave one side and you appear on the other.
  Wrap indicators light up along the edge you are about to cross.
- Self-collision, sparking components and energised barriers are fatal **unless**
  an active Shield absorbs the hit.
- Moving into the cell the tail is vacating is legal (a normal tail-follow).
  Moving into it while the trail is still growing is fatal.

### Scoring

| Event | Points |
| --- | --- |
| Energy node | `100 + 25 × speedTier` |
| Combo multiplier | ×1 for streaks 1–2, then +0.5× every 2 collections, capped at ×4 |
| Terminal activation | `250 + 25 × speedTier` |
| Terminal pair linked | `300 + 25 × speedTier` |
| Level clear bonus | `500 + 25 × speedTier` |
| Escape level bonus | additional `600` |
| Double Points power-up | doubles all node/terminal/link awards |

The combo window is **18 grid steps**. Collect inside it to build the streak;
let it lapse and the multiplier resets. All scoring is integer-only and
deterministic, so identical runs produce identical scores.

### Difficulties

| Difficulty | Start speed | Speed ceiling |
| --- | --- | --- |
| Easy | 210 ms/tick (4.8 cells/s) | 105 ms/tick |
| Normal | 165 ms/tick (6.1 cells/s) | 85 ms/tick |
| Hard | 135 ms/tick (7.4 cells/s) | 72 ms/tick |

A separate **Game speed** slider (75%–125%) scales on top of difficulty.

---

## 4. Game modes

### Endless Survival

Infinite play until collision. Collecting nodes raises a speed tier every 5
nodes (up to 10 tiers, each ~7% faster). A new damaged component appears in a safe
location every 3 tiers, up to a maximum of 12. The board palette also shifts
environment as the tier climbs. High scores are tracked per difficulty.

### Campaign — 30 levels across 6 environments

| Chapter | Levels | Environment |
| --- | --- | --- |
| 1 | 1–5 | CPU Core |
| 2 | 6–10 | Memory Banks |
| 3 | 11–15 | Power Supply |
| 4 | 16–20 | Graphics Processor |
| 5 | 21–25 | Circuit Nexus |
| 6 | 26–30 | Reactor Core |

Four objective types are introduced progressively:

- **Collect** (from level 1) — gather a quota of energy nodes.
- **Activate terminals in sequence** (from level 3) — numbered terminals must be
  triggered in order; out-of-order terminals stay offline and show a warning.
- **Connect terminal pairs** (from level 5) — reach both endpoints of each pair.
- **Charge and escape** (from level 8) — collect a quota, which unlocks the exit
  gate, then reach it.

Levels also contain **sparking damaged components** (permanent hazards) and
**temporary electrical barriers** that pulse between dormant and energised state.

Star ratings: **1★** for completing, **2★** for finishing inside par time,
**3★** for finishing inside 78% of par time *without* burning a shield.

Progress is saved automatically. Levels unlock one at a time.

---

## 5. Power-ups

Four power-ups spawn occasionally on the board and expire after 260 steps if not
collected. Only one board power-up exists at a time.

| Power-up | Glyph | Duration | Effect |
| --- | --- | --- | --- |
| Slow Motion | ◷ | 8 s | Movement slows to 65% speed (a 35% reduction) |
| Double Points | ×2 | 12 s | All scoring doubled |
| Magnet | ⌁ | 10 s | Auto-collects energy within 2 cells (Euclidean) |
| Shield | ⬡ | 1 charge | Absorbs one fatal collision, then burns out |

Magnet collection grows the trail exactly like a direct pickup.

**Shield recovery** is designed to never trap the player: the shield is consumed,
the overlapping trail section is cut away so no duplicate segments remain, and a
**3-step grace window** follows. During grace, further collisions are phased
through instead of killing, and the trail is trimmed so the surge cannot re-enter
its own body. A shielded run always continues from a valid, collision-free state.

---

## 6. Interface

Main menu → Endless / Campaign / Difficulty / Achievements / Settings / How to Play.
In-game there is a pause modal and a results card. Results offer **Next Level**
(if a new level was unlocked), **Replay/Restart**, and **Menu**.

The HUD shows score, personal best, the live objective with a progress bar, current
speed in cells per second, the row context (speed tier in Endless, level name in
Campaign), and active power-up pills with countdown bars.

---

## 7. Accessibility

| Setting | What it does |
| --- | --- |
| **High contrast** | Brighter text, thicker outlines, punchier grid and pads |
| **Colourblind assist** | Adds shape/pattern cues: a chevron-marked tail, a faceted head core, dashed controls, and periodic sparks on live barriers so hazard state is never carried by colour alone |
| **Reduced motion** | Disables shake, particle bursts, animated jitter and long transitions; the simulation is unaffected |
| **Game speed** | 75%–125% independent of difficulty |
| **Screen shake** | 0%–100% intensity |
| **Music volume** | 0%–100% |
| **Effects volume** | 0%–100% |

Everything is also reachable by keyboard, with visible focus rings, `role="switch"`
toggles, `aria-checked` difficulty radios, and labelled dialogs.

---

## 8. Saving and data safety

Progress lives in `localStorage` under these keys:

| Key | Contents |
| --- | --- |
| `powerSurgeCircuit.save.v1` | The live save |
| `powerSurgeCircuit.save.v1.backup` | The last known-good snapshot |
| `powerSurgeCircuit.corrupt.<timestamp>` | Quarantined damaged payloads |

Stored data is treated as hostile on load. Every field is type-checked, numbers
are clamped, and unknown keys are dropped. If the primary save is unreadable, the
backup is restored; a corrupt payload is **quarantined rather than deleted**, and
a known-bad primary is never allowed to overwrite a good backup. If both are
damaged, the game boots with defaults and says so in Settings → Storage status.

If `localStorage` is unavailable (private mode, disabled storage, quota exceeded),
the game keeps running in memory and warns that progress will not persist. No
storage failure can crash the game.

---

## 9. Testing

### Automated unit tests — 77 tests, all passing

```powershell
node --test "tests/*.test.mjs"
```

| Suite | Tests | Coverage |
| --- | --- | --- |
| `engine.test.mjs` | 31 | Grid movement, queued turns, reverse prevention, wraparound (both axes), trail growth, tail-follow, self-collision, shield recovery, barrier phases, magnet radius, power-up expiration, scoring determinism, combos, terminals, links, escape gating, stars, speed ramp, initial node placement |
| `levels.test.mjs` | 10 | All 30 levels generate and validate, determinism, chapter mapping, objective progression, structural overlap, spawn clearance, barrier gating, rejection of malformed layouts |
| `storage.test.mjs` | 11 | Round-trip, backup recovery, corrupt fallback, aggressive sanitisation, unlock progression, high-score monotonicity, idempotent achievements, reset semantics, throwing backends |
| `campaign.test.mjs` | 9 | Full 30-level walkthrough, reload persistence, best-value retention, out-of-range rejection, difficulty presets, achievement catalogue integrity |
| `integration.test.mjs` | 9 | 90-second autopiloted endless run with invariant checks, energy upkeep, shield safety, pause semantics, event-queue bounds, frame-time extremes, seed determinism |
| `themes.test.mjs` | 7 | Palette completeness, contrast ratios, panel luminance floor, grid visibility, theme distinctness |

### Browser QA — 41 checks, all passing

```powershell
node tools/qa.mjs
```

Drives a real headless Chrome/Edge instance over the DevTools Protocol and
verifies: clean boot with zero console errors and zero failed requests, no remote
URLs, all six menu screens, difficulty persistence, 30 campaign levels across
6 chapters, endless start and advance, **canvas pixels actually render**,
keyboard steering, reverse rejection, swipe steering, pause/resume, tap-to-pause,
HUD contents, a real self-collision producing a results card with the correct
cause, results persisting to storage, restart behaviour, power-up activation and
expiry with HUD pills, settings persistence, achievement listing and unlocking,
campaign completion with stars and unlocks, next-level advance, five viewport
layouts with no overflow, orientation change, accessibility classes, corrupt-save
recovery, and a sustained 150-frame timing sample.

See `TEST-REPORT.md` for the full results log.

### Visual capture

```powershell
node tools/shots.mjs        # writes screenshots/
```

### Live deployment smoke test

Confirms the delivered game boots, plays and renders through Apache rather than
the bundled test server:

```powershell
node tools/live-check.mjs
# or: node tools/live-check.mjs http://mother.local:8080/power-surge-circuit/
```

### Manual QA checklist

- [ ] Play a full Endless run on a phone — swipe response feels right.
- [ ] Rotate the device mid-run; the board re-lays out without losing state.
- [ ] Collect each of the four power-ups and watch the HUD pills.
- [ ] Take a shield hit and confirm the run continues cleanly.
- [ ] Complete campaign level 1 and use Next Level.
- [ ] Toggle each accessibility setting and confirm the visual change.
- [ ] Reload mid-campaign and confirm progress persists.

---

## 10. Configuration

All balancing values live in **`js/config.js`** — one frozen object, no magic
numbers elsewhere.

```js
CONFIG.speed.endless.tierFactor        // endless ramp aggressiveness
CONFIG.powerups.durations              // per-power-up durations in seconds
CONFIG.powerups.magnetRadius           // magnet reach in grid cells
CONFIG.powerups.endlessSpawn.minSteps  // power-up spawn spacing
CONFIG.scoring.comboWindowSteps        // combo window in grid steps
CONFIG.barriers.period                 // barrier on/off cycle length
CONFIG.campaign.starThreeEfficiency    // 3-star time threshold multiplier
```

Campaign level definitions (blueprints) live in `js/levels.js` as the
`BLUEPRINTS` array: objective type, counts, hazard count, barrier count, speed
tier and level name. Environment palettes live in `js/themes.js`.

---

## 11. Project layout

```
power-surge-circuit/
├── index.html              Markup, screen stack, modals
├── manifest.json           PWA manifest (installed app metadata)
├── package.json            Test/tooling scripts (no dependencies)
├── README.md               This file
├── TEST-REPORT.md          Full test results
├── assets/
│   └── icon.svg            Vector app icon (the only asset file)
├── css/
│   └── style.css           Full interface styling
├── js/
│   ├── config.js           All balancing constants
│   ├── rng.js              Seeded deterministic PRNG
│   ├── themes.js           Environment palettes
│   ├── achievements.js     Achievement catalogue
│   ├── storage.js          Versioned, defensive persistence
│   ├── levels.js           30 campaign blueprints + procedural validation
│   ├── engine.js           Headless deterministic simulation
│   ├── renderer.js         Canvas rendering and effects
│   ├── audio.js            Web Audio synthesis
│   ├── input.js            Keyboard + swipe input
│   └── main.js             Application shell and game loop
├── tests/                  Node test suites
├── tools/                  Local server, browser QA, screenshot capture
└── screenshots/            Captured reference images
```

### Architecture notes

`engine.js` has **no** DOM, canvas, audio or storage dependencies. It is driven by
`update(dt)` in real time or `step()` for exact tests. Rendering only ever reads
engine state and drains transient events, so the simulation is testable in Node
and impossible to perturb from the presentation layer.

---

## 12. Performance

- Static layers (background, board plate, grid, traces, hazards) are pre-rendered
  once into offscreen canvases and re-drawn as a single `drawImage`.
- Glow uses a small, fixed number of additive gradient passes rather than
  `shadowBlur`, which is very expensive on mobile GPUs.
- Particle count is capped at 320, and an adaptive quality factor scales particle
  bursts down automatically if frame times exceed ~34 ms.
- The device pixel ratio is clamped to 2, so 3× phones do not pay for pixels that
  cannot be seen.
- The simulation is capped at 4 grid steps per frame, so a backgrounded tab cannot
  cause an unbounded catch-up spiral.
- `backdrop-filter` is deliberately avoided over the live canvas: stacked blur
  layers force an expensive offscreen composite every frame and blanked the board
  on some GPU backends.
- Measured in headless Chrome with software rendering (SwiftShader, the worst
  case): **median frame time 16.7 ms**. Hardened against `dt` spikes of up to 30 s.

---

## 13. Audio

All sound is generated with oscillators, gain envelopes and a shared noise buffer.
There are no audio files.

- Collection, magnet, power-up, shield, terminal, link, spark, hazard, ramp,
  collision, meltdown, level clear/fail, UI and achievement cues.
- A generative soundtrack arpeggiates a minor-pentatonic scale over a per-theme
  chord progression, so it never repeats exactly and never sounds off-key.
- The `AudioContext` is created on the first user gesture, respecting browser
  autoplay policies. Audio suspends when the page is hidden.

---

## 14. Deployment

The project is fully portable: copy the folder anywhere and serve it over HTTP.

1. **Do not deploy publicly without approval** (see the deviations section).
2. For `arcade.mattbullis.com`, upload the folder contents to the web root for
   that host and ensure `.js` is served as `text/javascript` (any standard server
   does this).
3. Keep the directory structure intact — all paths are relative.
4. No environment variables, server config or API keys are required.

---

## 15. Known issues and deviations

See **section 15 of TEST-REPORT.md** for the consolidated list. In summary:

- `mother.local` requires a hosts-file entry; `localhost:8080` always works.
- The headless screenshot pipeline cannot capture the canvas layer under
  certain GPU settings. This is a **capture artifact only** — the canvas is
  verified by direct pixel readback (1738/1790 lit samples) in the QA suite.
- Portrait phones show the board at its natural 24:18 size, which leaves vertical
  margin below it on tall screens. This is deliberate: cropping the board would
  hide part of the playfield.

---

## 16. Licences and credits

Original work. No third-party code, fonts, audio or artwork. Everything is
procedurally generated by the code in this repository.
