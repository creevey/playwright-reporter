# Docker Screenshot Rendering Determinism: Investigation Report

Date: 2026-08-24
Status: verified end-to-end on a consumer project (104 screenshot tests)

## Problem

Playwright screenshot tests run **inside a Linux Docker container** failed with tiny,
stable pixel differences when the same container ran on different host platforms
(Linux x64 CI runner vs macOS Apple Silicon):

```text
Error: expect(page).toHaveScreenshot(expected) failed
  11 pixels (ratio 0.01 of all image pixels) are different.
  ...
  captured a stable screenshot
  11 pixels (ratio 0.01 of all image pixels) are different.
```

Diffs were small (4–746 pixels after pixelmatch's anti-aliasing classification) and
**stable across retries** — not flakiness.

## Initial hypotheses (ranked a priori)

| #   | Hypothesis                                                                                 | Verdict                                                    |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| H1  | Different image variant per host arch (arm64 vs amd64 builds, SSE/AVX vs NEON AA rounding) | ❌ disproved for this case                                 |
| H2  | Rosetta/QEMU emulation on Apple Silicon when forcing `--platform linux/amd64`              | ❌ not in play (native arch was used)                      |
| H3  | Chromium rendering non-determinism ([crbug.com/919955](https://crbug.com/919955))          | ❌ diffs stable across captures                            |
| H4  | **Font stack / fontconfig differences between container images**                           | ✅ **root cause**                                          |
| H5  | Playwright/Chromium version skew                                                           | ❌ same `@playwright/test` from lockfile                   |
| H6  | Timezone/locale/dynamic content                                                            | ❌ (separately confirmed for 3 stale artifacts, see below) |
| H7  | CPU feature dispatch within same arch                                                      | ❌ not in play                                             |

## Evidence

Pixel-level analysis (Pillow) of Playwright's `-expected` / `-actual` / `-diff` triplets
from a consumer project's failing runs.

### Case 1 — `Repo-Checked`: a single text line shifted by 3px

- 1,684 raw differing pixels, **all confined to one line** (`✓ Доступ есть: kiss (talk/kiss)`,
  y 136–151). The rest of the 1440×900 page was pixel-identical.
- Shifting the actual image by **+3px horizontally** collapses the diff from 1,683 → **42**
  residual pixels. A constant integer shift = a **text advance-width difference**, not
  anti-aliasing noise and not a color change.
- Mechanism: FreeType **hinting changes glyph x-advances** (grid fitting). The two
  environments applied different hintstyles, so the same glyphs in the same font occupy
  slightly different widths and the whole line lands 3px apart.

### Case 2 — `ProjectForm-Edit`: grayscale vs subpixel (LCD) antialiasing

- 22,506 raw differing pixels across text all over the page (pixelmatch later classified
  all but 50 as AA).
- Expected image: **0 colored pixels** in text regions — pure grayscale antialiasing.
- Actual image: **1,944 colored pixels** — orange/blue fringes characteristic of
  **LCD subpixel antialiasing** (verified visually in 6× zoomed crops).
- Mechanism: Chromium on Linux takes text AA mode from **fontconfig**. The environments
  disagreed on the `rgba` setting.

### Root cause: distro-level fontconfig defaults, not CPU arch

The comparison pair was: committed `-linux.png` baseline (generated in CI on a
**`node:24`** image = Debian, x64) vs a local run inside an **Ubuntu 24.04 (noble)**
container (`mcr.microsoft.com/playwright:*-noble` family) on Apple Silicon.

Verified directly in Docker:

```text
node:24 (Debian, CI):                       mcr.microsoft.com/playwright:*-noble (Ubuntu):
  /etc/fonts/conf.d:                          /etc/fonts/conf.d:
    (no sub-pixel config)                       10-sub-pixel-rgb.conf   ← subpixel AA on
    (no hinting config)                         10-hinting-slight.conf  ← slight hinting
  fc-match -v sans-serif:                     fc-match -v sans-serif:
    antialias: True                               antialias: True
    hintstyle: 1 (FULL)                           hintstyle: 0 (SLIGHT)
    rgba: (unset → grayscale)                     rgba: 5 (RGB subpixel)
```

The host-platform correlation was **coincidental**: CI happened to run a Debian-based
image on x64, local runs an Ubuntu-based image on arm64. The pixel differences track the
**image's fontconfig**, not the host and not the CPU.

Side note: Playwright's `-linux.png` snapshot suffix cannot express this — Debian and
Ubuntu containers both resolve to the same `-linux` baseline name, so the two
environments silently collided on one set of baselines.

## Verification: 3-way comparison after unifying the image

The consumer project switched its CI job from `node:24` to
`mcr.microsoft.com/playwright:v1.62.1-noble` (matching the local Docker image) and
produced a fresh artifacts report. Three-way comparison across all 104 failing tests:

| Comparison                                     | Result                                                      |
| ---------------------------------------------- | ----------------------------------------------------------- |
| CI (noble, x64) vs local Mac (noble, arm64)    | **100/103 byte-identical**                                  |
| Old baseline (Debian, x64) vs CI (noble, x64)  | 93/93 differ — expected; baselines predate the image switch |
| CI `expected` attachment == committed baseline | 93/93 — confirms CI compared against stale baselines        |

Supporting checks:

- **104/104 CI actuals show LCD subpixel rendering** → the noble fontconfig is active in
  CI; the image switch took effect.
- The cross-arch anti-aliasing noise predicted by
  [microsoft/playwright#13873](https://github.com/microsoft/playwright/issues/13873) did
  **not** materialize for this DOM/text-heavy suite: with identical fontconfig, x64 and
  arm64 Chromium builds rendered **bit-identical** pages.

### The 3 remaining diffs: stale artifacts, not rendering

`ProjectForm-Create`, `ProjectForm-Submit-Errors`, `ProjectForm-Edit` still differed —
but structurally (up to 11,671 significant pixels, max channel delta 225, full-width
bands). Crop inspection showed the CI render contains a **"Системная инструкция"**
section absent from the local render: the application code changed between the local run
(Aug 20) and the CI run (Aug 24). Content drift, not a rendering difference; a local
re-run on the current commit resolves them.

## Conclusions

1. **The container image — not the host platform and not the CPU architecture — is the
   unit of rendering determinism.** Docker shares the host kernel/CPU but rendering is
   governed by userspace: fontconfig, fonts, and the browser build inside the image.
2. **Debian-based and Ubuntu-based images render text differently by default**
   (grayscale + full hinting vs subpixel RGB + slight hinting). Mixing them across
   baseline generation and verification produces exactly the "few pixels, stable,
   everywhere on text" failure signature.
3. **x64 and arm64 variants of the same image render DOM/text bit-identically** in
   practice. Native-arch images on Apple Silicon are sufficient — **no amd64 emulation
   needed** (Rosetta/QEMU is slower, less stable, and buys nothing).
4. Residual risk: the Playwright team has reproduced small cross-arch AA differences on
   **canvas 2D / complex SVG / WebGL (SwiftShader)** content (SSE/AVX vs NEON code
   paths). If such content enters the suite, handle per-test with `maxDiffPixels` rather
   than platform contortions.

## Recommendations (applied)

- ✅ Use the **same image flavor + version** for baseline generation and verification
  everywhere (CI switched to `mcr.microsoft.com/playwright:v<version>-noble`).
- ✅ Run **native architecture** on every host; do not force `--platform linux/amd64`
  on Apple Silicon.
- ⏳ Regenerate `-linux` baselines **once from the unified CI image** after switching
  flavors (via CI `--update-snapshots` or approving actuals from the artifacts report).
- Keep generation and verification in the same image going forward (the "Run & update
  baselines" button in docker mode already does this).

## Reproduction / diagnostic cheat sheet

```bash
# Inside the container that produced a suspicious screenshot:
fc-match -v sans-serif | grep -E 'rgba|hintstyle'
#   rgba: 5 + hintstyle: 0  → Ubuntu-family defaults (subpixel AA, slight hinting)
#   no rgba + hintstyle: 1  → Debian-family defaults (grayscale AA, full hinting)
# These must match between baseline generation and verification.

ls /etc/fonts/conf.d/ | grep -E 'sub-pixel|hinting'
#   10-sub-pixel-rgb.conf / 10-hinting-slight.conf present → Ubuntu-family.

# Whole-page fingerprint: subpixel rendering leaves colored fringes.
# Count colored pixels (max(R,G,B)-min(R,G,B) > 20) in a text-heavy region —
# grayscale rendering yields 0, LCD rendering yields hundreds/thousands.
```
