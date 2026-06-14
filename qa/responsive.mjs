// Responsive layout + core-interaction pass across phone / desktop / wide.
//
// Asserts: no horizontal overflow on any view; the windowed grid resolves the
// expected column count; the DOM stays bounded (virtualization is on, not a full
// mount); a jump-pill scroll-to-section parks the opened header under the sticky
// toolbar; and the topbar search opens its printings overlay multi-up. Screenshots
// land in SHOTS for eyeballing.
//
//   node responsive.mjs
import { open, goto, horizOverflow, tileCount, gridColumns, check, summary, SHOTS } from './harness.mjs';
import { join } from 'node:path';

const ACCORDION_BODY = '.deck-cat .deck-cat__body';

for (const profile of ['phone', 'desktop', 'wide']) {
  const { browser, page, errors } = await open(profile);
  try {
    // --- Year picker (the default /<year>/ view) ---
    await goto(page, '/2024/', 1200);
    let of = await horizOverflow(page);
    check(`[${profile}] picker: no horizontal overflow`, !of.overflowing, JSON.stringify(of));

    // --- All-cards accordion (windowed) ---
    await goto(page, '/2024/#all', 2300);
    of = await horizOverflow(page);
    check(`[${profile}] #all: no horizontal overflow`, !of.overflowing, JSON.stringify(of));

    const expectCols = profile === 'phone' ? 2 : 4; // 2-up phones; 4-up cap under the editorial max-width
    const g = await gridColumns(page, ACCORDION_BODY);
    check(`[${profile}] #all: grid resolves ${expectCols} columns`, !!g && g.cols === expectCols, JSON.stringify(g));

    const nTop = await tileCount(page);
    check(`[${profile}] #all: DOM windowed (not the full category)`, nTop > 0 && nTop < 150, `${nTop} tiles`);

    // --- Scroll-to-section: a jump-pill opens its category under the toolbar ---
    const jump = await page.evaluate(async () => {
      const p = [...document.querySelectorAll('.year-pill')].find((x) => /planeswalk/i.test(x.textContent));
      if (!p) return null;
      p.click();
      await new Promise((r) => setTimeout(r, 700));
      const openCat = [...document.querySelectorAll('.deck-cat')].find((c) => c.querySelector('[aria-expanded="true"]'));
      const head = openCat && openCat.querySelector('.deck-cat__head');
      const tb = document.querySelector('.year-toolbar');
      return {
        title: openCat && openCat.querySelector('.deck-cat__title') ? openCat.querySelector('.deck-cat__title').textContent : null,
        headTop: head ? Math.round(head.getBoundingClientRect().top) : null,
        tbBottom: tb ? Math.round(tb.getBoundingClientRect().bottom) : null,
      };
    });
    const parked = !!jump && jump.headTop !== null && jump.tbBottom !== null && Math.abs(jump.headTop - jump.tbBottom) <= 14;
    check(`[${profile}] scroll-to-section parks under toolbar`, parked, JSON.stringify(jump));
    await page.screenshot({ path: join(SHOTS, `responsive-${profile}.png`) });

    // --- Topbar search -> printings overlay ---
    await goto(page, '/2024/', 800);
    await page.click('.mtg-search__input');
    await page.type('.mtg-search__input', 'Sol Ring', { delay: 30 });
    await page.waitForTimeout(1300);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    const ov = await page.evaluate(() => {
      const o = document.querySelector('.mtg-find');
      if (!o) return null;
      const grid = o.querySelector('.mtg-find__grid');
      const cols = grid ? getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).filter((t) => t[0] !== '[').length : 0;
      return { tiles: o.querySelectorAll('.card-tile').length, cols };
    });
    const ovOk = !!ov && ov.tiles > 0 && (profile === 'phone' ? ov.cols === 2 : ov.cols >= 3);
    check(`[${profile}] search overlay opens multi-up with printings`, ovOk, JSON.stringify(ov));
    await page.screenshot({ path: join(SHOTS, `responsive-${profile}-search.png`) });

    check(`[${profile}] no console errors`, errors.length === 0, errors.slice(0, 4).join(' | '));
  } finally {
    await browser.close();
  }
}
summary('responsive');
