# QA harness

Headless [Playwright](https://playwright.dev/) checks for **mtg-all.dirtyshoulders.com**,
driven against the live origin. The scripts exist to catch regressions in the parts of
the site that are easy to break and hard to eyeball: the **viewport windowing**
(virtualization), **responsive layout**, and **touch targets**.

## Prerequisites

- Node 22+ (the scripts are ESM with top-level `await`).
- `npm install` in this folder (pulls `playwright-core`; it does **not** download a browser).
- A Chromium binary. Either install one with `npx playwright install chromium`, or point
  `CHROMIUM_PATH` at an existing build.

On **admin01** a known-good Chromium and a `playwright-core` install already exist, so no
`npm install` is needed there:

```bash
cd ~/projects/mtg-all/qa
export CHROMIUM_PATH="$HOME/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome"
export PW_CORE_PATH="$HOME/work/americanraiders-redesign/node_modules/playwright-core/index.js"
node responsive.mjs && node windowing.mjs && node touch-targets.mjs
```

## Configuration (env vars, all optional)

| Var | Default | Meaning |
| --- | --- | --- |
| `HOST` | `mtg-all.dirtyshoulders.com` | Host header / TLS cert name to request. |
| `ORIGIN_IP` | `10.10.10.50` | IP that `HOST` is MAP-ed onto via Chromium's host resolver, so the real hostname (and the production Caddy + cert) is exercised while the request lands on the private origin. Set `ORIGIN_IP=""` to use public DNS instead. |
| `CHROMIUM_PATH` | Playwright's resolved path | Chromium executable. |
| `PW_CORE_PATH` | resolved from `node_modules` | Fallback path to a `playwright-core` install. |
| `SHOTS` | `qa/shots/` | Screenshot output dir (git-ignored). |
| `PROFILE` | `desktop` | (probe.mjs only) viewport profile to load. |

Viewport profiles live in `harness.mjs`: **phone** (390x844, touch/coarse-pointer),
**desktop** (1440x900), **wide** (1920x1080).

## Scripts

| Script | What it asserts |
| --- | --- |
| `responsive.mjs` | Across phone/desktop/wide: no horizontal overflow; the windowed grid resolves the expected column count (2-up phone, 4-up cap otherwise); the DOM stays bounded (virtualization is live); a jump-pill scroll-to-section parks the opened header under the sticky toolbar; the topbar search opens its printings overlay multi-up; no console errors. |
| `windowing.mjs` | The virtualization regression guard. Per phone/desktop: the document-height-implied row height is sane (close to the real ~300px tile pitch, not the ~2x that the column-count bug produced); and at several scroll depths the viewport below the sticky stack is filled with tiles (no blank band) with the DOM still bounded. |
| `touch-targets.mjs` | Both `.mtg-search__input` fields are >=44px on a coarse pointer and stay compact on a fine pointer (the WCAG 2.5.5 rule in `styles/search.css`). |
| `probe.mjs` | Not a test - dumps a view's structure (title, tile count, open categories, jump pills, notable classes) for debugging. `node probe.mjs /2024/#all`. |

Each test script prints `PASS`/`FAIL` lines and a final `OK`/`FAILED` summary, and exits
non-zero on any failure. Screenshots for the run land in `SHOTS` for a visual once-over.

## Notes

- These hit the **live** origin; there is no local server. To point at a different
  deployment, override `HOST`/`ORIGIN_IP`.
- The harness ignores TLS errors (`--ignore-certificate-errors`) because the request is
  routed to a private IP while presenting the public hostname.
