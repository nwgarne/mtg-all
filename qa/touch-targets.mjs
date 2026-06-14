// Touch-target guard for the search fields (WCAG 2.5.5).
//
// On a coarse pointer (touch) both .mtg-search__input fields - the topbar search
// and the in-overlay "search another card" - must be >=44px tall. On a fine pointer
// (desktop mouse) they intentionally keep the compact editorial height. This guards
// the (pointer: coarse) rule in styles/search.css from silently regressing.
//
//   node touch-targets.mjs
import { open, goto, check, summary } from './harness.mjs';

for (const profile of ['phone', 'desktop']) {
  const { browser, page } = await open(profile);
  try {
    await goto(page, '/2024/', 800);
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    const topbar = await page.evaluate(() => {
      const i = document.querySelector('.mtg-search__input');
      return i ? Math.round(i.getBoundingClientRect().height) : null;
    });

    // Open the printings overlay to measure its "search another card" field.
    await page.click('.mtg-search__input');
    await page.type('.mtg-search__input', 'Sol Ring', { delay: 30 });
    await page.waitForTimeout(1300);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1800);
    const overlay = await page.evaluate(() => {
      const i = document.querySelector('.mtg-find__search .mtg-search__input');
      return i ? Math.round(i.getBoundingClientRect().height) : null;
    });

    if (coarse) {
      check(`[${profile}] coarse pointer detected`, true, '');
      check(`[${profile}] topbar search >= 44px`, topbar !== null && topbar >= 44, `${topbar}px`);
      check(`[${profile}] overlay search >= 44px`, overlay !== null && overlay >= 44, `${overlay}px`);
    } else {
      check(`[${profile}] fine pointer detected`, true, '');
      check(`[${profile}] topbar search stays compact (< 44px)`, topbar !== null && topbar < 44, `${topbar}px`);
      check(`[${profile}] overlay search stays compact (< 44px)`, overlay !== null && overlay < 44, `${overlay}px`);
    }
  } finally {
    await browser.close();
  }
}
summary('touch-targets');
