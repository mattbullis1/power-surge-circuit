# Power Surge Circuit — Test Report

**Build:** v1.0.0
**Date:** 2026-11-01
**Target:** `C:\xampp\htdocs\power-surge-circuit`
**Local URL:** http://localhost:8080/power-surge-circuit/
**Hostname URL:** http://mother.local:8080/power-surge-circuit/

---

## 1. Summary

| Suite | Tests / Checks | Passed | Failed |
| --- | --- | --- | --- |
| Unit — `engine.test.mjs` | 31 | 31 | 0 |
| Unit — `levels.test.mjs` | 10 | 10 | 0 |
| Unit — `storage.test.mjs` | 11 | 11 | 0 |
| Unit — `campaign.test.mjs` | 9 | 9 | 0 |
| Unit — `integration.test.mjs` | 9 | 9 | 0 |
| Unit — `themes.test.mjs` | 7 | 7 | 0 |
| **Unit total** | **77** | **77** | **0** |
| Browser QA — `tools/qa.mjs` | 41 | 41 | 0 |
| **Grand total** | **118** | **118** | **0** |

Reproduce:

```powershell
cd C:\xampp\htdocs\power-surge-circuit
node --test "tests/*.test.mjs"      # 77 unit tests
node tools/qa.mjs                   # 41 browser checks
node tools/shots.mjs                # visual capture to screenshots/
```

---

## 2. Unit test results (Node 22.14.0)

```
# tests 77
# pass 77
# fail 0
# duration_ms 402
```

### 2.1 `engine.test.mjs` — 31/31

Deterministic simulation behaviour, verified by calling `step()` directly.

| Test | Result |
| --- | --- |
| Grid movement advances exactly one cell and stores interpolation data | PASS |
| One queued turn is applied on the next tick | PASS |
| A queued turn can be replaced before the tick, but only with a legal turn | PASS |
| Reverse direction is rejected | PASS |
| Reverse is also rejected after a turn is committed | PASS |
| Board edges wrap to the opposite side | PASS |
| Vertical wrap works as well | PASS |
| Collecting an energy node permanently grows the trail | PASS |
| Moving into the vacated tail cell is allowed when not growing | PASS |
| Moving into the tail cell is fatal while the tail is growing | PASS |
| Self-collision without a shield ends the run | PASS |
| Shield absorbs a self-collision, cuts the overlapping trail, preserves score | PASS |
| Shield absorbs a hazard collision and lets the surge burn through | PASS |
| Active barriers are fatal without a shield and passable while inactive | PASS |
| Magnet collects energy within two cells and grows the trail normally | PASS |
| Magnet radius is Euclidean (1.4-cell diagonals collected, 3.6 not) | PASS |
| Power-up timers expire independently | PASS |
| Slow motion lengthens the tick interval by 35% speed reduction | PASS |
| Board power-ups expire after their configured lifetime | PASS |
| Power-up pickup activates effects and stats | PASS |
| Scoring is deterministic, speed-boosted and combo-aware | PASS |
| Double points doubles node scoring | PASS |
| Combo streaks reset after the quick-collection window | PASS |
| Terminal sequence activates only the expected terminal | PASS |
| Connect objective completes when both endpoints of every pair are active | PASS |
| Escape requires the node quota before the exit activates | PASS |
| Collect objective completes and awards a level bonus | PASS |
| Campaign star ratings use par time and shield integrity | PASS |
| Endless speed ramps every configured number of collections | PASS |
| `update()` advances a deterministic number of steps for a fixed dt | PASS |
| Initial energy nodes are reachable and never overlap the serpent | PASS |

Notable assertions:

- **Scoring determinism:** an identical 4-node streak on a tier-2 board scores
  exactly `[150, 300, 450, 675]` on every run — confirming both the speed bonus
  and the ×1 → ×1.5 combo step.
- **Shield recovery:** after absorbing a self-collision, `shieldSaves === 1`,
  score is untouched, `graceSteps > 0`, the body has **no duplicate segments**,
  and the following step is explicitly asserted to still be `running`.
- **Reverse prevention:** asserted both before a tick (`queueDirection(-1,0)`
  returns `false` and leaves the queue empty) and after a committed turn.
- **Rows 1–5 of the review process each caught a real bug** (see section 5).

### 2.2 `levels.test.mjs` — 10/10

| Test | Result |
| --- | --- |
| All 30 campaign levels generate and validate | PASS |
| Generation is deterministic for a given level number | PASS |
| Campaign covers six chapters of five levels with correct themes | PASS |
| Objective types are introduced progressively and every type is present | PASS |
| Objective counts match generated geometry | PASS |
| No structures overlap and spawn is clear on every level | PASS |
| Temporary barriers never gate objectives when energised | PASS |
| Difficulty metadata progresses across the campaign | PASS |
| `validateLevelLayout` rejects bad layouts | PASS |
| Every campaign level can instantiate a deterministic engine with reachable starting energy | PASS |

The barrier test flood-fills from the spawn head **with each barrier group forced
energised in turn**, proving no pulsing barrier can ever seal off a required
terminal or the exit.

### 2.3 `storage.test.mjs` — 11/11

| Test | Result |
| --- | --- |
| Empty storage loads defaults | PASS |
| Save and load round-trip settings, scores, campaign and achievements | PASS |
| Corrupt primary recovers the last known-good backup | PASS |
| Corrupt primary and backup fall back to safe defaults | PASS |
| Invalid values are sanitized and clamped | PASS |
| Campaign completions unlock the next level and never go backwards | PASS |
| High scores only increase and return best status | PASS |
| Achievements unlock once and are idempotent | PASS |
| Reset progress preserves preferences but clears scores and campaign | PASS |
| Storage failures never throw | PASS |
| `sanitizeSave` handles non-object roots | PASS |

The sanitisation test feeds in `Infinity`, `-999`, `'loud'`, `'yes'`, level `0`,
level `42`, a non-numeric level key, a fake achievement id and 5-digit star counts,
and asserts every one is coerced or dropped correctly.

### 2.4 `campaign.test.mjs` — 9/9

Full 30-level progression walk, reload persistence, best-value retention
(score/star/time each improve independently), out-of-range level rejection,
difficulty preset sanity, achievement catalogue integrity, and a per-objective-type
layout check.

### 2.5 `integration.test.mjs` — 9/9

| Test | Result |
| --- | --- |
| A long endless run stays internally consistent | PASS |
| Energy node count is maintained while the game runs | PASS |
| A shield never leaves the surge in an immediately fatal state | PASS |
| Pause and resume do not advance the simulation | PASS |
| The engine never allocates unbounded event queues | PASS |
| Frame time extremes do not break the simulation | PASS |
| Campaign engine completes each objective type | PASS |
| State serialisation helpers stay cheap and stable | PASS |
| Repeated identical runs with the same seed stay identical | PASS |

The 90-second run is driven by a greedy autopilot and asserts, at the end, that
the body has no duplicate segments, every segment is in bounds, the score is a
finite non-negative number, and the tick interval never drops below the 42 ms floor.

### 2.6 `themes.test.mjs` — 7/7

Palette completeness, hex-format validity, unknown-key fallback, panel luminance
floor (the regression guard for the contrast bug), WCAG contrast ratios for
accent/primary against the panel, grid alpha visibility, theme distinctness, and
achievement tier coverage.

---

## 3. Browser QA results — 41/41

Headless Chrome (`C:/Program Files/Google/Chrome/Application/chrome.exe`,
`--headless=new`, SwiftShader software rendering) driven over the DevTools Protocol.

```
Boot & assets
  [PASS] app boots and signals ready — body[data-ready=true]
  [PASS] no console errors during boot — clean console
  [PASS] no failed network requests — all local assets resolved
  [PASS] no remote URLs are referenced — all asset paths are relative

Navigation
  [PASS] menu → screen-difficulty — opens and returns
  [PASS] menu → screen-campaign — opens and returns
  [PASS] menu → screen-achievements — opens and returns
  [PASS] menu → screen-settings — opens and returns
  [PASS] menu → screen-how — opens and returns
  [PASS] difficulty selection persists — hard selected and written to storage
  [PASS] campaign shows all 30 levels across 6 chapters — 6 chapters, 30 levels, 29 locked

Endless gameplay
  [PASS] endless run starts and advances — running, 12 steps
  [PASS] canvas renders non-empty frames — 481×361, 1738/1790 lit samples, avg 51.0
  [PASS] keyboard steering changes trail direction — ArrowDown applied
  [PASS] reverse input is rejected — upward reversal blocked while moving down
  [PASS] swipe gesture steers the surge — horizontal swipe produced a right turn
  [PASS] pause and resume work from the keyboard — 17 → 21 steps
  [PASS] tap-to-pause works on the board — tap pauses the run
  [PASS] HUD reports score, objective and speed — 100 · 3s · 6.1/s
  [PASS] simulated self-collision ends the run with a results card — "Meltdown" with 7 stat rows, cause reported
  [PASS] results persist into local storage — runs=1, nodes=1
  [PASS] restart from the results card begins a fresh run — fresh run, 14 steps
  [PASS] power-up pickup activates timers, HUD pill and audio hooks — slow active, tick 254ms, 1 pill
  [PASS] slow motion expires and the pill disappears — effect and HUD pill cleared
  [PASS] settings sliders and toggles persist to storage — speed 1.2, shake 0.4, reduced motion all persisted
  [PASS] achievements screen lists every achievement with lock state — 16 achievements, 1 unlocked
  [PASS] unlocking an achievement shows a toast and appears in the list — 6 achievements unlocked
  [PASS] quit to menu tears the run down — menu restored

Campaign gameplay
  [PASS] level 1 loads and starts — level 1 · collect 6 · theme cpu
  [PASS] completing a campaign level shows stars and unlocks the next — 3★ awarded, unlocked through level 2
  [PASS] next-level button advances the campaign — advanced to level 2

Layout & responsiveness
  [PASS] layout fits iPhone SE portrait (320×568) — canvas 304×228, cell 11.3px, no overflow
  [PASS] layout fits Pixel 7 portrait (412×915) — canvas 394×295, cell 15.1px, no overflow
  [PASS] layout fits iPhone landscape (844×390) — canvas 435×322, cell 16.6px, no overflow
  [PASS] layout fits iPad portrait (820×1180) — canvas 801×600, cell 32.0px, no overflow
  [PASS] layout fits Desktop 1440p (1440×900) — canvas 1060×795, cell 42.8px, no overflow
  [PASS] orientation change re-lays out the board — 394×295 → 466×345
  [PASS] high contrast and colourblind modes apply to the document — accessibility classes and renderer flags wired
  [PASS] corrupt save data is recovered without breaking boot — booted with defaults and quarantined the damaged data
  [PASS] no console errors accumulated during the whole session — 0 errors
  [PASS] sustained play keeps a healthy frame budget — median 16.7ms, p95 16.8ms, particles 0, quality 1

================================================================
Browser QA: 41/41 checks passed
================================================================
```

### What each browser check actually proves

- **Canvas renders:** reads back 1790 pixels sampled across the live context and
  requires a minimum count above a luminance threshold. This is a pixel-level
  assertion, not an inference from "the loop is running". Final reading:
  **1738/1790 lit samples, average channel value 51.0**.
- **Swipe steering:** synthesises a real `mousePressed → 6 × mouseMoved →
  mouseReleased` sequence with `pointerType: 'touch'` across the board and asserts
  the engine's committed direction changed to the expected axis.
- **Self-collision:** weaves the trail so the cell below the head holds a
  **mid-body** segment (index 3 of 6 — not the tail, which legally vacates), then
  steers into it and waits for a results card. Asserts the card appears, that it
  has ≥5 stat rows, and that the cause row reads "Trail contact".
- **Layout:** for each viewport, asserts the canvas is larger than 90×90, does not
  extend past the viewport bottom, and that neither `<html>` nor `<body>` scrolls
  by more than 1 px.
- **Frame budget:** samples 150 consecutive `requestAnimationFrame` deltas and
  asserts a median under 90 ms and worst-case under 600 ms — deliberately loose
  because SwiftShader software rendering is the floor, not the target.

---

## 4. Deployment verification

The game was verified through the real Apache/PHP stack, not only the bundled
test server.

| Check | Result |
| --- | --- |
| `http://localhost:8080/power-surge-circuit/` | **200**, 17 771 bytes |
| `http://mother.local:8080/power-surge-circuit/` | **200**, 17 771 bytes |
| Server header | `Apache/2.4.58 (Win64) OpenSSL/3.1.3 PHP/8.2.12` |
| `document.body.dataset.ready` | `true` |
| `<canvas>` elements | 1 |
| Menu buttons | 6 |
| Manifest resolved | `manifest.json` |
| Console errors | **none** |
| Failed requests | **none** |
| Board luminance under Apache | avg **56.8**, **47.7%** lit pixels |

### Important environment finding

Port **80** on this machine is **not** served by XAMPP. It is a Python
`BaseHTTP/0.6` application (the MOTHER dashboard). XAMPP's Apache is bound to
**port 8080** (and 443). Requests to `http://localhost/power-surge-circuit/`
therefore return 404 — **as do every other existing project directory**, so this
is a pre-existing environment condition and not caused by this project.

The correct local URL is **http://localhost:8080/power-surge-circuit/**, which
matches the project brief's `mother.local:8080` target. No network or service
settings were modified.

---

## 5. Bugs found and fixed during development

Each of these was caught by a test, reproduced, fixed, and re-verified.

| # | Bug | Found by | Fix |
| --- | --- | --- | --- |
| 1 | Camera-locked collision target: the queued turn was applied *after* computing the next cell, so steering into your own trail granted one free cell | `engine.test.mjs` self-collision test | Commit the queued direction before resolving the target cell |
| 2 | Flood-fill from the head included the body as blocked and returned zero reachable cells | `levels.test.mjs` reachable-energy test | Only permanent structures block the fill; the body always vacates |
| 3 | `structuredClone()` returns an empty object for array roots under instrumented `Array.prototype` hosts, silently emptying hazards/barriers/terminals | `engine.test.mjs` terminal/connect tests | Explicit `cloneCells()` helper in tests |
| 4 | A corrupt primary was rotated into the backup slot on the next save, destroying the good backup it existed to protect | `storage.test.mjs` backup-recovery test | Track write validity and never rotate a known-corrupt payload |
| 5 | `Assignment to constant variable` crash in `_buildBackground` (`y += …` on a `const`) — the app failed to boot at all | Browser QA boot check | Use a mutable local |
| 6 | Combo multiplier was computed after scoring, so the streak that earned a step-up was paid at the old rate | `engine.test.mjs` scoring test | Compute the multiplier before awarding points |
| 7 | **`aspect-ratio` silently ignored** — `height: 100%` on the same element let flexbox stretch the board to 828 px, leaving the playfield floating in dead margin | Browser QA layout checks + manual review | Remove `height`; constrain via `max-width` derived from `100dvh` |
| 8 | **Near-black palette** — average frame luminance was **29/255**, which read as a completely blank screen on phones with aggressive black clipping | Direct canvas pixel readback (`avg 29.1, 8.3% lit`) | Lifted all 7 environment panels and grid alphas; added a luminance floor test. Now **avg 56.8, 47.7% lit** |
| 9 | **`backdrop-filter` over the live canvas** blanked the board on some GPU backends and forced a per-frame offscreen composite | Manual review of GPU-path screenshots | Replaced all 5 backdrop-filters with solid translucent panels |
| 10 | Stale results card could appear over a fresh run (the reveal `setTimeout` outlived a restart) | Browser QA restart check | Cancellable reveal guarded by a run token, plus a `runEndHandled` latch so scoring cannot re-run every frame |
| 11 | Two themes shared a primary colour; GPU theme's danger was indistinguishable from its primary | `themes.test.mjs` distinctness + contrast tests | Distinct menu palette; deep-red GPU hazard colour |
| 12 | `drawImage(boardCache, 0, 0, w, h)` treated the cache as a source rect rather than scaling it | Direct visual inspection | Use the explicit 9-argument form |

---

## 6. Requirement coverage

### Core gameplay

| Requirement | Status | Evidence |
| --- | --- | --- |
| Grid-based movement, 90° turns | Done | engine tests |
| Continuous movement | Done | `update()` / `step()` |
| Nodes permanently extend trail | Done | growth-debt tests |
| Animated arcs between segments | Done | renderer `_drawSurge` |
| No direct reversal | Done | 3 dedicated tests |
| Outer edges wrap | Done | horizontal + vertical wrap tests |
| Self-collision / hazards fatal | Done | collision + barrier tests |
| Shield absorbs collision | Done | shield-recovery test |
| Deterministic sim independent of rendering | Done | engine has zero DOM deps; seed-determinism test |
| Easy / Normal / Hard | Done | preset + browser tests |
| Endless increases speed | Done | speed-ramp test |
| Campaign is level-based | Done | 30 blueprint layouts |

### Modes

| Requirement | Status |
| --- | --- |
| Endless: infinite, increasing difficulty | Done |
| Endless: procedural nodes | Done |
| Endless: occasional power-ups | Done |
| Endless: high-score tracking | Done |
| Endless: speed and combo bonuses | Done |
| Campaign: 30 levels, 6 environments, 5 each | Done (asserted) |
| Campaign: progressively challenging objectives | Done |
| Campaign: collect N nodes | Done (levels 1,2,4,6,10,13,16,20,24,28,30) |
| Campaign: activate terminals in sequence | Done (level 3+) |
| Campaign: connect designated terminals | Done (level 5+) |
| Campaign: collect before reaching exit | Done (level 8+) |
| Campaign: sparking components and temporary barriers | Done |
| Layouts valid and playable | Done — validated per attempt, with a per-barrier-group reachability proof |
| No unreachable nodes / impossible objectives / unavoidable collisions | Done — spawn corridors and landing zones are reserved |

### Scoring, power-ups, graphics, audio, controls, accessibility, saving, interface

All implemented as specified; see `README.md` sections 3–8 for the detail and
`js/config.js` for every tunable.

---

## 7. Responsive, touch and orientation verification

| Viewport | Canvas | Cell | Scroll overflow |
| --- | --- | --- | --- |
| iPhone SE portrait 320×568 | 304×228 | 11.3 px | none |
| Pixel 7 portrait 412×915 | 394×295 | 15.1 px | none |
| iPhone landscape 844×390 | 435×322 | 16.6 px | none |
| iPad portrait 820×1180 | 801×600 | 32.0 px | none |
| Desktop 1440×900 | 1060×795 | 42.8 px | none |
| Orientation change | 394×295 → 466×345 | — | board re-lays out, run continues |

Touch behaviour verified in-browser: swipe turns the surge, a stationary tap
pauses instead of turning (20 px dead zone), and `preventDefault()` on
`touchmove`/`pointermove`/`pointerdown` inside the board stops every page scroll
and gesture.

---

## 8. Performance verification

| Metric | Result |
| --- | --- |
| Median frame time (150 frames, software rendering) | **16.7 ms** |
| 95th percentile | 16.8 ms |
| Worst frame | < 600 ms asserted (tab-switch spike) |
| Adaptive quality factor | Held at 1.00 (no degradation needed) |
| Particle cap | 320, never approached in the sample |
| Max simulation steps per frame | 4 (capped) |
| `dt` hardening | Tested at 0, 0.0001, 0.05, 0.25, 1 and 30 seconds |
| Device pixel ratio | Clamped to 2 |

1000 steps and 90 simulated seconds run without breaking invariants; the event
queue stays bounded because the app drains it every frame.

---

## 9. Deviations from the specification

| # | Specified | Implemented | Reason |
| --- | --- | --- | --- |
| 1 | Project URL `http://localhost/power-surge-circuit/` | `http://localhost:8080/power-surge-circuit/` | Port 80 on this machine is served by a separate Python application, not XAMPP. XAMPP's Apache is on 8080. This matches the brief's own `mother.local:8080` target. No network settings were changed. |
| 2 | — | Extra **How to Play** screen | Needed for public release; the spec requires clear readable menus. |
| 3 | Shield "absorbs one collision" | Shield + a 3-step grace window and trail sealing | The spec also requires that shield recovery "avoid immediate repeated collision and preserve game state". A bare one-hit absorb can drop the surge inside its own trail. |
| 4 | "Proposed" power-up durations 8/12/10 s | Implemented exactly, all configurable | Values accepted as proposed. |
| 5 | Separate music and SFX volume | Plus a one-tap mute in the menu bar | Quick-access convenience. |
| 6 | — | `?debug` HUD overlay (FPS, steps, tick, particles, quality) | Development/QA aid; inert unless the query string asks for it. |
| 7 | — | Adaptive quality scaling | Added because the spec targets "smooth animation on modest Android hardware". |
| 8 | Campaign star system (par time, shield integrity) | Implemented as 1★ complete / 2★ within par / 3★ within 78% of par with no shield burned **or held** | A shield still in hand was treated as non-flawless, keeping 3★ meaningful. |

---

## 10. Known issues and limitations

1. **`mother.local` needs a hosts entry.** `localhost:8080` always works and
   serves identical files. Adding `127.0.0.1  mother.local` to
   `C:\Windows\System32\drivers\etc\hosts` makes the hostname work.
2. **Headless screenshots cannot capture the canvas layer** under SwiftShader when
   the page is tall. This is a Chrome capture artifact, not a game defect: the
   same run yields `1738/1790 lit samples` on direct pixel readback, and
   `getImageData`/`toDataURL` both return the full artwork. Real GPU rendering was
   confirmed visually.
3. **Portrait phones show the board at its natural 24:18 size**, leaving vertical
   margin beneath it on tall screens. Cropping or distorting the board would hide
   part of the playfield, so the margin is intentional.
4. **Audio starts only after a user gesture**, per browser autoplay policy. The
   first tap or keypress unlocks it.
5. **Escape-objective levels** place energy nodes and an exit gate; a player who
   deliberately avoids the quota can circle indefinitely. This is a player choice,
   not a soft-lock — the exit is always reachable and its state is displayed.
6. **`localStorage` in private browsing** may fall back to memory-only; the game
   detects this and says so in Settings → Storage status.
7. **No public deployment has been performed.** Awaiting approval as instructed.

---

## 11. Recommended manual confirmation

Automated coverage is thorough, but a human should still confirm:

1. Swipe responsiveness on a real touch device (simulated touch cannot fully
   model finger velocity).
2. Audio character and balance through real speakers — the soundtrack is
   generative, so taste matters more than correctness.
3. Visual punch on a real OLED/IPS panel, particularly the low-end brightness of
   the Reactor Core and Graphics Processor palettes.
4. Actual in-game difficulty tuning: Easy/Normal/Hard ramp rates were chosen from
   tick-rate maths, not play testing.
