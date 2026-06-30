// Above-the-fold screenshots of the homepage hero (desktop + wide), plus a
// measurement of how far down the real content (the year grid) starts. For
// eyeballing the .hero.is-home compaction. Hits live foiltilt.com via the
// harness MAP (set HOST=foiltilt.com).
//
//   HOST=foiltilt.com node hero-shot.mjs
import { open, goto, SHOTS } from './harness.mjs';
import { join } from 'node:path';

for (const profile of ['desktop', 'wide']) {
  const { browser, page } = await open(profile);
  try {
    await goto(page, '/', 2500);
    const out = join(SHOTS, `hero-${profile}.png`);
    await page.screenshot({ path: out }); // viewport shot = what loads above the fold
    const m = await page.evaluate(() => {
      const r = (el) => (el ? Math.round(el.getBoundingClientRect().top) : null);
      const hero = document.querySelector('.hero');
      return {
        vh: window.innerHeight,
        heroTop: r(hero),
        heroBottom: hero ? Math.round(hero.getBoundingClientRect().bottom) : null,
        ridgelineTop: r(document.querySelector('#ridgeline')),
        archiveTop: r(document.querySelector('.section')),
        yearGridTop: r(document.querySelector('.year-grid')),
        firstYearCardTop: r(document.querySelector('.year-card')),
      };
    });
    console.log(`${profile}  ${JSON.stringify(m)}  -> ${out}`);
  } finally {
    await browser.close();
  }
}
