// Ad-hoc DOM-structure probe - the "what does this view actually render" helper
// used when a selector-based check is failing and you need ground truth.
//
//   node probe.mjs [path]          (default /2024/#all)
//   PROFILE=phone node probe.mjs /2024/
import { open, goto } from './harness.mjs';

const path = process.argv[2] || '/2024/#all';
const { browser, page, errors } = await open(process.env.PROFILE || 'desktop');
await goto(page, path, 2500);

const out = await page.evaluate(() => {
  const classes = new Set();
  document.querySelectorAll('[class]').forEach((e) => String(e.className).split(/\s+/).forEach((c) => c && classes.add(c)));
  return {
    title: document.title,
    cardTiles: document.querySelectorAll('.card-tile').length,
    hasToolbar: !!document.querySelector('.year-toolbar'),
    openCategories: [...document.querySelectorAll('.deck-cat')]
      .filter((c) => c.querySelector('[aria-expanded="true"]'))
      .map((c) => (c.querySelector('.deck-cat__title') || {}).textContent),
    jumpPills: [...document.querySelectorAll('.year-pill')].map((p) => p.textContent.replace(/\s+/g, ' ').trim()),
    notableClasses: [...classes].filter((c) => /^(deck-cat|year-|mtg-|card-tile|hero|stat-row)/.test(c)).sort(),
  };
});

console.log(JSON.stringify(out, null, 2));
console.log('console errors:', errors.length, errors.slice(0, 6));
await browser.close();
