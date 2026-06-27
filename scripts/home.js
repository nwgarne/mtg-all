/*
 * home.js - MTG by year homepage.
 * Fetches /data/years.json and renders:
 *   - the hero tagline (total card count) + a confident stat-row
 *   - a slow-drifting card-wall of iconic year art behind the hero
 *   - "The Ridgeline": an inline-SVG history-of-Magic data-viz
 *   - an era-banded grid of year cards (spotlight year + end-cap)
 *
 * CSP: script-src 'self'. No inline handlers; all DOM built here. The only
 * inline styles written are background-image (year art / card-wall) and the
 * per-era --era custom prop (style-src allows 'unsafe-inline').
 *
 * Code style mirrors decks-astro/public/scripts/decklist.js (IIFE, el()
 * helper, createElement throughout).
 */
(function () {
  'use strict';

  const DATA_URL = '/data/years.json';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // MTG eras, newest-first to match the grid. Each carries a WUBRG tint that
  // becomes the year tiles' number-glow, the ridge peaks, and the divider pip.
  const ERAS = [
    { name: 'Universes Beyond',   min: 2023, color: 'var(--mtg-g)' },
    { name: 'The Arena Era',      min: 2018, color: 'var(--mtg-u)' },
    { name: 'Modern Renaissance', min: 2011, color: 'var(--mtg-r)' },
    { name: 'The New Frame',      min: 2003, color: 'var(--mtg-b)' },
    { name: 'The Founding',       min: 0,    color: 'var(--mtg-w)' }
  ];
  function eraFor(year) {
    const y = Number(year);
    for (let i = 0; i < ERAS.length; i++) if (y >= ERAS[i].min) return ERAS[i];
    return ERAS[ERAS.length - 1];
  }

  // --- Helpers ---
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svgEl(tag, attrs) {
    const n = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function commas(n) {
    const num = Number(n);
    if (!isFinite(num)) return '0';
    return Math.round(num).toLocaleString('en-US');
  }
  function priceFull(v) {
    const num = Number(v);
    if (!isFinite(num)) return '';
    return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function priceWhole(v) {
    const num = Number(v);
    if (!isFinite(num)) return '';
    return '$' + Math.round(num).toLocaleString('en-US');
  }
  function pluralCards(n) { return commas(n) + (Number(n) === 1 ? ' card' : ' cards'); }
  function pluralSets(n) { return commas(n) + (Number(n) === 1 ? ' set' : ' sets'); }
  function appendSep(parent, ch) { parent.appendChild(el('span', 'sep', ch || '·')); }
  function safeUrl(u) { return String(u).replace(/["'\\]/g, ''); }

  // A WUBRG mana-pip cluster (the brand motif).
  function buildPips() {
    const wrap = el('span', 'mtg-pips');
    wrap.setAttribute('aria-hidden', 'true');
    ['w', 'u', 'b', 'r', 'g'].forEach(function (c) {
      wrap.appendChild(el('i', 'pip pip--' + c));
    });
    return wrap;
  }

  // --- Hero tagline ---
  function renderTagline(data) {
    const node = document.getElementById('hero-tagline');
    if (!node) return;
    const yearCount = Array.isArray(data.years) ? data.years.length : 0;
    node.textContent = '';
    node.appendChild(document.createTextNode('Every Magic: the Gathering card, grouped by the year it released. '));
    node.appendChild(el('strong', null, commas(data.totalCards) + ' cards'));
    node.appendChild(document.createTextNode(' across ' + yearCount + ' years.'));
  }

  // --- Hero stat-row ---
  function renderHeroStats(data, years) {
    const node = document.getElementById('hero-stats');
    if (!node) return;
    const totalSets = years.reduce(function (a, y) { return a + (Number(y.sets) || 0); }, 0);
    const stats = [
      [commas(data.totalCards), 'Cards catalogued'],
      [String(years.length), 'Years of Magic'],
      [commas(totalSets), 'Sets released']
    ];
    node.textContent = '';
    stats.forEach(function (s) {
      const stat = el('div', 'hero-stat');
      stat.appendChild(el('span', 'hero-stat__num', s[0]));
      stat.appendChild(el('span', 'hero-stat__lbl', s[1]));
      node.appendChild(stat);
    });
  }

  // --- Hero card-wall (drifting art band behind the headline) ---
  function renderHeroWall(years) {
    const wall = document.getElementById('hero-cardwall');
    if (!wall) return;
    const arts = years.map(function (y) { return y.title && y.title.art; }).filter(Boolean);
    if (arts.length < 4) return;
    const track = el('div', 'hero-cardwall__track');
    // two identical copies so the -50% drift loops seamlessly
    [0, 1].forEach(function () {
      arts.forEach(function (art) {
        const a = el('div', 'hero-cardwall__art');
        a.style.backgroundImage = "url('" + safeUrl(art) + "')";
        track.appendChild(a);
      });
    });
    wall.textContent = '';
    wall.appendChild(track);
    requestAnimationFrame(function () { wall.classList.add('is-ready'); });
  }

  // --- Year card ---
  function buildYearCard(y, opts) {
    opts = opts || {};
    const era = opts.era || eraFor(y.year);
    const card = el('a', 'year-card' + (opts.feature ? ' year-card--feature' : ''));
    card.id = 'yc-' + y.year;
    card.setAttribute('href', '/' + y.year + '/');
    card.style.setProperty('--era', era.color);

    const title = y.title || null;
    const topName = title && title.name ? title.name : '';
    const topNameFront = topName.split(' // ')[0];
    const yearLabel = (title ? 'View ' + y.year + ', top card ' + topName : 'View ' + y.year)
      + ', ' + pluralCards(y.cards) + ', ' + pluralSets(y.sets);
    card.setAttribute('aria-label', yearLabel);

    if (title && title.art) {
      card.style.backgroundImage = "url('" + safeUrl(title.art) + "')";
    } else {
      card.classList.add('is-plain');
    }

    if (opts.feature) {
      const flag = el('div', 'year-card__flag', 'Latest');
      card.appendChild(flag);
    }

    const counts = el('div', 'year-card__counts');
    counts.appendChild(el('strong', null, commas(y.cards)));
    counts.appendChild(document.createTextNode(' cards'));
    appendSep(counts);
    counts.appendChild(el('strong', null, commas(y.sets)));
    counts.appendChild(document.createTextNode(' sets'));
    card.appendChild(counts);

    card.appendChild(el('div', 'year-card__year', y.year));

    if (title && topName) {
      const top = el('div', 'year-card__top');
      top.appendChild(el('span', 'year-card__top-lbl', 'Top card:'));
      const nameEl = el('span', 'year-card__top-name', topNameFront);
      nameEl.setAttribute('title', topName);
      top.appendChild(nameEl);
      const whole = priceWhole(title.value);
      if (whole) {
        appendSep(top);
        const priceEl = el('span', 'year-card__top-price', whole);
        const full = priceFull(title.value);
        priceEl.setAttribute('title', 'Top card price' + (full ? ': ' + full : ''));
        top.appendChild(priceEl);
      }
      card.appendChild(top);
    }

    const arrow = el('span', 'year-card__arrow', '›');
    arrow.setAttribute('aria-hidden', 'true');
    card.appendChild(arrow);
    return card;
  }

  // --- Era-banded grid: spotlight newest year, then eras, then an end-cap ---
  function renderGrid(data, years) {
    const grid = document.getElementById('year-grid');
    if (!grid) return;
    grid.textContent = '';
    if (!years.length) {
      grid.appendChild(el('p', 'year-grid__status', 'No years to show.'));
      return;
    }

    // Per-era ranges + totals (over ALL years, so a divider's range includes the
    // spotlight year that we pull out above it).
    const eraInfo = {};
    years.forEach(function (y) {
      const e = eraFor(y.year);
      const g = eraInfo[e.name] || (eraInfo[e.name] = { era: e, min: 9999, max: 0, count: 0, cards: 0 });
      const yr = Number(y.year);
      if (yr < g.min) g.min = yr;
      if (yr > g.max) g.max = yr;
      g.count += 1;
      g.cards += Number(y.cards) || 0;
    });

    const frag = document.createDocumentFragment();

    // Spotlight = newest year, pulled out as a wide feature tile.
    const spotlight = years[0];
    if (spotlight && spotlight.year) {
      frag.appendChild(buildYearCard(spotlight, { feature: true, era: eraFor(spotlight.year) }));
    }

    // Remaining years, grouped into era chapters.
    let lastEra = null;
    years.slice(1).forEach(function (y) {
      if (!y || !y.year) return;
      const e = eraFor(y.year);
      if (e.name !== lastEra) {
        lastEra = e.name;
        const info = eraInfo[e.name];
        const div = el('div', 'year-era');
        div.style.setProperty('--era', e.color);
        div.appendChild(el('span', 'year-era__pip'));
        div.appendChild(el('span', 'year-era__name', e.name));
        if (info) {
          div.appendChild(el('span', 'year-era__range', info.min + '-' + info.max));
          div.appendChild(el('span', 'year-era__meta', info.count + ' yrs · ' + commas(info.cards) + ' cards'));
        }
        frag.appendChild(div);
      }
      frag.appendChild(buildYearCard(y, { era: e }));
    });

    // End-cap: a deliberate bookend that retires the orphaned last row.
    const totalSets = years.reduce(function (a, y) { return a + (Number(y.sets) || 0); }, 0);
    const oldest = years[years.length - 1].year;
    const cap = el('div', 'year-endcap');
    cap.appendChild(el('div', 'year-endcap__spine'));
    cap.appendChild(el('div', 'year-endcap__big', commas(data.totalCards) + ' cards'));
    cap.appendChild(el('div', 'year-endcap__sub',
      years.length + ' years · ' + commas(totalSets) + ' sets · every printing since ' + oldest));
    frag.appendChild(cap);

    grid.appendChild(frag);
  }

  // --- The Ridgeline: cards printed per year, 1993 -> now ---
  function renderRidgeline(data, years) {
    const host = document.getElementById('ridgeline');
    if (!host) return;
    const chrono = years.slice().reverse(); // oldest -> newest
    const n = chrono.length;
    if (n < 2) return;
    const maxCards = chrono.reduce(function (m, y) { return Math.max(m, Number(y.cards) || 0); }, 0) || 1;
    const TOP = 14, BOT = 6, BASE = 100 - BOT;
    function xAt(i) { return (i / (n - 1)) * 1000; }
    function yAt(v) { return BASE - ((Number(v) || 0) / maxCards) * (BASE - TOP); }

    host.textContent = '';

    // Head
    const head = el('div', 'ridge__head');
    const kick = el('span', 'ridge__kicker');
    kick.appendChild(buildPips());
    kick.appendChild(document.createTextNode('The shape of Magic'));
    head.appendChild(kick);
    head.appendChild(el('span', 'ridge__caption',
      'Cards printed each year, ' + chrono[0].year + ' to ' + chrono[n - 1].year));
    host.appendChild(head);

    const wrap = el('div', 'ridge-wrap');

    // SVG (stretched; area + line only)
    const svg = svgEl('svg', { class: 'ridge', viewBox: '0 0 1000 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    const defs = svgEl('defs');
    const grad = svgEl('linearGradient', { id: 'ridgeFill', x1: '0', y1: '0', x2: '0', y2: '1' });
    grad.appendChild(svgEl('stop', { offset: '0', 'stop-color': 'oklch(80% 0.14 82 / 0.26)' }));
    grad.appendChild(svgEl('stop', { offset: '1', 'stop-color': 'oklch(80% 0.14 82 / 0)' }));
    defs.appendChild(grad);
    svg.appendChild(defs);
    svg.appendChild(svgEl('line', { class: 'ridge__baseline', x1: '0', y1: BASE, x2: '1000', y2: BASE }));

    let line = 'M ' + xAt(0) + ' ' + yAt(chrono[0].cards);
    for (let i = 1; i < n; i++) line += ' L ' + xAt(i) + ' ' + yAt(chrono[i].cards);
    const area = 'M 0 ' + BASE + ' ' + line.replace(/^M /, 'L ') + ' L 1000 ' + BASE + ' Z';
    svg.appendChild(svgEl('path', { class: 'ridge__area', d: area, fill: 'url(#ridgeFill)' }));
    svg.appendChild(svgEl('path', { class: 'ridge__line', d: line, pathLength: '1' }));
    wrap.appendChild(svg);

    // Tooltip
    const tip = el('div', 'ridge__tip');
    const tipYear = el('div', 'ridge__tip-year');
    const tipCards = el('div', 'ridge__tip-line');
    const tipMeta = el('div', 'ridge__tip-line');
    tip.appendChild(tipYear); tip.appendChild(tipCards); tip.appendChild(tipMeta);
    wrap.appendChild(tip);

    // Interactive peaks (HTML dots over the stretched svg)
    const peaks = el('div', 'ridge__peaks');
    function showTip(y, i) {
      tipYear.textContent = y.year;
      tipCards.textContent = '';
      tipCards.appendChild(el('span', 'v', commas(y.cards)));
      tipCards.appendChild(document.createTextNode(' cards · ' + pluralSets(y.sets)));
      tipMeta.textContent = '';
      tipMeta.appendChild(document.createTextNode('top card '));
      tipMeta.appendChild(el('span', 'p', priceWhole(y.value)));
      tip.style.left = (xAt(i) / 10) + '%';
      tip.style.top = yAt(y.cards) + '%';
      tip.classList.add('is-on');
      const tile = document.getElementById('yc-' + y.year);
      if (tile) tile.classList.add('is-spotlit');
    }
    function hideTip(y) {
      tip.classList.remove('is-on');
      const tile = document.getElementById('yc-' + y.year);
      if (tile) tile.classList.remove('is-spotlit');
    }
    chrono.forEach(function (y, i) {
      const e = eraFor(y.year);
      const dot = el('button', 'ridge__peak');
      dot.type = 'button';
      dot.style.left = (xAt(i) / 10) + '%';
      dot.style.top = yAt(y.cards) + '%';
      dot.style.setProperty('--era', e.color);
      dot.setAttribute('aria-label', y.year + ', ' + pluralCards(y.cards) + ', ' + pluralSets(y.sets) + '. View year.');
      dot.addEventListener('mouseenter', function () { dot.classList.add('is-active'); showTip(y, i); });
      dot.addEventListener('mouseleave', function () { dot.classList.remove('is-active'); hideTip(y); });
      dot.addEventListener('focus', function () { dot.classList.add('is-active'); showTip(y, i); });
      dot.addEventListener('blur', function () { dot.classList.remove('is-active'); hideTip(y); });
      dot.addEventListener('click', function () { window.location.href = '/' + y.year + '/'; });
      peaks.appendChild(dot);
    });
    wrap.appendChild(peaks);

    // Axis ticks (a handful of years)
    const axis = el('div', 'ridge__axis');
    const ticks = [0, Math.round((n - 1) * 0.33), Math.round((n - 1) * 0.66), n - 1];
    ticks.filter(function (v, idx, arr) { return arr.indexOf(v) === idx; }).forEach(function (i) {
      const t = el('span', 'ridge__axis-tick', chrono[i].year);
      t.style.left = (xAt(i) / 10) + '%';
      axis.appendChild(t);
    });
    wrap.appendChild(axis);
    host.appendChild(wrap);

    // Draw-in on scroll-into-view.
    function draw() { wrap.classList.add('is-drawn'); }
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { draw(); io.disconnect(); }
        });
      }, { threshold: 0.25 });
      io.observe(wrap);
    } else {
      draw();
    }
  }

  function showError() {
    const grid = document.getElementById('year-grid');
    if (grid) {
      grid.textContent = '';
      grid.appendChild(el('p', 'year-grid__status', 'Could not load the year list. Please reload.'));
    }
  }

  function safely(fn) { try { fn(); } catch (e) { console.error('home:', e); } }

  // --- Boot ---
  fetch(DATA_URL)
    .then(function (r) {
      if (!r.ok) throw new Error('years.json HTTP ' + r.status);
      return r.json();
    })
    .then(function (data) {
      const years = Array.isArray(data.years) ? data.years.filter(function (y) { return y && y.year; }) : [];
      safely(function () { renderTagline(data); });
      safely(function () { renderHeroStats(data, years); });
      safely(function () { renderHeroWall(years); });
      safely(function () { renderRidgeline(data, years); });
      safely(function () { renderGrid(data, years); });
    })
    .catch(function (err) {
      console.error('home: failed to load years.json', err);
      showError();
    });
})();
