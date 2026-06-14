// Shared headless-Playwright harness for mtg-all.dirtyshoulders.com.
//
// Every runner imports this for browser setup, viewport profiles, and DOM
// helpers, so the individual scripts stay short and the launch/config logic
// lives in one place.
//
// Config is env-driven (all optional). Defaults target the live caddy01 origin
// from inside the LAN, hitting the real public hostname (so its TLS cert and the
// production Caddy config apply) while routing the request to the private IP:
//
//   HOST           site host header / cert name   (default mtg-all.dirtyshoulders.com)
//   ORIGIN_IP      IP that HOST is MAP-ed onto via Chromium's host resolver.
//                  Set ORIGIN_IP="" to skip the MAP and use public DNS instead.
//                  (default 10.10.10.50 = caddy01 on the LAN)
//   CHROMIUM_PATH  path to a Chromium binary (default: playwright's resolved one)
//   PW_CORE_PATH   path to a playwright-core install, used only if the package is
//                  not resolvable from node_modules (run `npm install` in qa/)
//   SHOTS          screenshot output dir (default qa/shots, git-ignored)
//
// See qa/README.md for the known-good admin01 invocation.

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// Resolve playwright-core from node_modules, or fall back to PW_CORE_PATH. The
// package is CommonJS, so depending on how it resolves the chromium export can
// arrive either as a named export or under `.default`; accept both.
let chromium;
{
  let mod;
  try {
    mod = await import('playwright-core');
  } catch (e) {
    if (!process.env.PW_CORE_PATH) {
      throw new Error('playwright-core not found. Run `npm install` in qa/, or set ' +
        'PW_CORE_PATH=/path/to/playwright-core (see qa/README.md).');
    }
    mod = await import(process.env.PW_CORE_PATH);
  }
  chromium = mod.chromium || (mod.default && mod.default.chromium);
  if (!chromium) {
    throw new Error('Resolved playwright-core but found no chromium export ' +
      '(check that PW_CORE_PATH points at a playwright-core entry point).');
  }
}

export const HOST = process.env.HOST || 'mtg-all.dirtyshoulders.com';
export const ORIGIN_IP = process.env.ORIGIN_IP === undefined ? '10.10.10.50' : process.env.ORIGIN_IP;
export const BASE = `https://${HOST}`;

export const SHOTS = (() => {
  const dir = process.env.SHOTS || join(HERE, 'shots');
  mkdirSync(dir, { recursive: true });
  return dir;
})();

// Viewport profiles. Phone is a touch (coarse-pointer) device so the responsive
// CSS (2-up grid, 44px touch targets) actually engages.
export const PROFILES = {
  phone: {
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  wide: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
};

function exePath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try { const p = chromium.executablePath(); if (p) return p; } catch (e) { /* fall through */ }
  return undefined; // let Playwright try its own default location
}

export async function launch() {
  const args = ['--ignore-certificate-errors'];
  if (ORIGIN_IP) args.push(`--host-resolver-rules=MAP ${HOST} ${ORIGIN_IP}`);
  return chromium.launch({ executablePath: exePath(), args });
}

// Open a page in the given profile. Returns { browser, ctx, page, errors };
// `errors` accumulates console errors + uncaught page errors for assertions.
export async function open(profile = 'desktop') {
  const browser = await launch();
  const ctx = await browser.newContext(PROFILES[profile] || PROFILES.desktop);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  return { browser, ctx, page, errors };
}

// Navigate + settle. The bigger year scopes load a multi-MB JSON, so callers
// pass a longer settle for #all.
export async function goto(page, path = '/', waitMs = 1500) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(waitMs);
}

// Disable the site's global smooth-scroll so scrollTo() jumps land instantly,
// otherwise measurements/screenshots can race the in-flight scroll animation.
export async function killSmoothScroll(page) {
  await page.addStyleTag({ content: 'html{scroll-behavior:auto !important}' });
}

// ---- DOM measurement helpers (evaluated in the page) ----

export const horizOverflow = (page) => page.evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  innerW: window.innerWidth,
  // +2 tolerance: scrollWidth can report a sub-pixel hair over innerWidth.
  overflowing: document.documentElement.scrollWidth > window.innerWidth + 2,
}));

export const tileCount = (page) => page.evaluate(() => document.querySelectorAll('.card-tile').length);

// Real (used) column count + first-track width from a grid's resolved tracks,
// the same source the production windowing reads (gridMetrics).
export const gridColumns = (page, sel) => page.evaluate((s) => {
  const b = document.querySelector(s);
  if (!b) return null;
  const tracks = getComputedStyle(b).gridTemplateColumns.trim().split(/\s+/).filter((t) => t[0] !== '[');
  return { cols: tracks.length, colW: Math.round(parseFloat(tracks[0]) || 0) };
}, sel);

// ---- tiny pass/fail reporter (shared per-process state) ----

let _fails = 0;
export function check(name, pass, detail = '') {
  if (!pass) _fails++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  return pass;
}
export function summary(label) {
  const ok = _fails === 0;
  console.log(`\n${ok ? 'OK' : 'FAILED'}: ${label} (${_fails} failure${_fails === 1 ? '' : 's'})`);
  if (!ok) process.exitCode = 1;
  return _fails;
}
