// Virtualization (viewport-windowing) regression guard.
//
// This is the script that caught the mobile blank-scroll bug: the windowing must
// read the REAL column count from the laid-out grid (getComputedStyle tracks), not
// re-derive it from the 220px minmax. If it guesses 1 column on the 2-up phone grid,
// colW doubles, rowH (~610 vs ~296) doubles, the spacers over-reserve the scroll
// height ~2x, and the rendered window rides above the viewport: a blank band below
// the fold that goes fully black on a big scroll jump.
//
// Two invariants per profile:
//   1. doc-height-implied row height is sane (close to the real ~300px tile pitch,
//      not ~2x), so the spacers reserve the right total height.
//   2. at several scroll depths the viewport BELOW the sticky stack is filled with
//      tiles (no blank band), and the DOM stays bounded (windowing is live).
//
//   node windowing.mjs
import { open, goto, killSmoothScroll, check, summary, SHOTS } from './harness.mjs';
import { join } from 'node:path';

for (const profile of ['phone', 'desktop']) {
  const { browser, page } = await open(profile);
  try {
    await goto(page, '/2024/#all', 3600); // cards.json lazy-loads on scope entry; first category (Legendary Creatures, 1,700) auto-opens
    await killSmoothScroll(page);

    // (1) implied row height = full document height / total rows.
    const m = await page.evaluate(() => {
      const openCat = [...document.querySelectorAll('.deck-cat')].find((c) => c.querySelector('[aria-expanded="true"]'));
      const body = openCat.querySelector('.deck-cat__body');
      const cnt = parseInt((openCat.querySelector('.deck-cat__count')?.textContent || '0').replace(/[^0-9]/g, ''), 10);
      const cols = getComputedStyle(body).gridTemplateColumns.trim().split(/\s+/).filter((t) => t[0] !== '[').length;
      const rows = Math.ceil(cnt / cols);
      const docH = document.documentElement.scrollHeight;
      return { cnt, cols, rows, docH, impliedRowH: Math.round(docH / rows) };
    });
    // Tiles are ~488x680 art + a ~65px footer; at any real colW the row pitch sits
    // ~250-460px. The bug doubled it to ~600+ on phones.
    check(`[${profile}] implied row height sane (250-460px, not ~2x)`, m.impliedRowH >= 250 && m.impliedRowH <= 460, JSON.stringify(m));

    // (2) deep-scroll coverage + bounded DOM at several depths.
    for (const y of [3000, 9000, 30000]) {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(650);
      const cov = await page.evaluate(() => {
        const W = window.innerWidth, H = window.innerHeight;
        const x = Math.max(40, Math.round(W * 0.18)); // inside column 1, clear of the inter-column gutter
        const ys = [Math.round(H * 0.55), Math.round(H * 0.7), Math.round(H * 0.85), H - 30]; // all below the sticky stack
        const hits = ys.map((yy) => {
          const e = document.elementFromPoint(x, yy);
          return !!(e && e.closest('.card-tile'));
        });
        return { tiles: document.querySelectorAll('.card-tile').length, covered: hits.every(Boolean), hits };
      });
      check(`[${profile}] deep-scroll y=${y}: viewport covered (no blank band)`, cov.covered, JSON.stringify(cov));
      check(`[${profile}] deep-scroll y=${y}: DOM bounded (<160 tiles)`, cov.tiles < 160, `${cov.tiles} tiles`);
    }

    await page.evaluate(() => window.scrollTo(0, 9000));
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(SHOTS, `windowing-${profile}.png`) });
  } finally {
    await browser.close();
  }
}
summary('windowing');
