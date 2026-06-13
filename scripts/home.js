/*
 * home.js — MTG by year homepage.
 * Fetches /data/years.json and renders the hero tagline (total card count)
 * plus a responsive grid of year cards, newest year first. Each card is a
 * full-bleed cover tile whose background is that year's highest-value card
 * art, links to /<year>/, and shows the year, card/set counts, and the top
 * card + price.
 *
 * CSP: script-src 'self'. No inline handlers; all DOM built here. The only
 * inline style written is the per-year background-image (style-src allows
 * 'unsafe-inline').
 *
 * Code style mirrors decks-astro/public/scripts/decklist.js (IIFE, el()
 * helper, createElement throughout).
 */
(function () {
  'use strict';

  const DATA_URL = '/data/years.json';

  // --- Helpers ---
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // 12968 -> "12,968". Non-finite input renders as "0".
  function commas(n) {
    const num = Number(n);
    if (!isFinite(num)) return '0';
    return Math.round(num).toLocaleString('en-US');
  }

  // Full price like the spec's $1,234.56 (used for tooltips / precision).
  function priceFull(v) {
    const num = Number(v);
    if (!isFinite(num)) return '';
    return '$' + num.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  // Whole-dollar price for the caption: 2299.99 -> "$2,300".
  function priceWhole(v) {
    const num = Number(v);
    if (!isFinite(num)) return '';
    return '$' + Math.round(num).toLocaleString('en-US');
  }

  function pluralCards(n) {
    return commas(n) + (Number(n) === 1 ? ' card' : ' cards');
  }
  function pluralSets(n) {
    return commas(n) + (Number(n) === 1 ? ' set' : ' sets');
  }

  function appendSep(parent, ch) {
    parent.appendChild(el('span', 'sep', ch || '·'));
  }

  // --- Hero tagline ---
  function renderTagline(data) {
    const node = document.getElementById('hero-tagline');
    if (!node) return;
    const yearCount = Array.isArray(data.years) ? data.years.length : 0;
    const total = commas(data.totalCards);
    node.textContent = '';
    node.appendChild(document.createTextNode('Every Magic: the Gathering card, grouped by the year it released. '));
    node.appendChild(el('strong', null, total + ' cards'));
    node.appendChild(document.createTextNode(' across ' + yearCount + ' years.'));
  }

  // --- Year card ---
  function buildYearCard(y) {
    const card = el('a', 'year-card');
    card.setAttribute('href', '/' + y.year + '/');

    const title = y.title || null;
    const topName = title && title.name ? title.name : '';
    const yearLabel = (title ? 'View ' + y.year + ' — top card ' + topName : 'View ' + y.year)
      + ', ' + pluralCards(y.cards) + ', ' + pluralSets(y.sets);
    card.setAttribute('aria-label', yearLabel);

    if (title && title.art) {
      // Inline background-image is the one inline style CSP permits here.
      // Wrap the URL in quotes and strip any quote chars so a stray "
      // in the data can't break out of the declaration.
      const safeArt = String(title.art).replace(/["'\\]/g, '');
      card.setAttribute('style', "background-image:url('" + safeArt + "')");
    } else {
      card.classList.add('is-plain');
    }

    // Top rail: card count · set count
    const counts = el('div', 'year-card__counts');
    counts.appendChild(el('strong', null, commas(y.cards)));
    counts.appendChild(document.createTextNode(' cards'));
    appendSep(counts);
    counts.appendChild(el('strong', null, commas(y.sets)));
    counts.appendChild(document.createTextNode(' sets'));
    card.appendChild(counts);

    // The big year.
    card.appendChild(el('div', 'year-card__year', y.year));

    // Caption: Top: <name> · $price
    if (title && topName) {
      const top = el('div', 'year-card__top');
      top.appendChild(el('span', 'year-card__top-lbl', 'Top:'));
      const nameEl = el('span', 'year-card__top-name', topName);
      nameEl.setAttribute('title', topName);
      top.appendChild(nameEl);
      const whole = priceWhole(title.value);
      if (whole) {
        appendSep(top);
        const priceEl = el('span', 'year-card__top-price', whole);
        const full = priceFull(title.value);
        if (full) priceEl.setAttribute('title', full);
        top.appendChild(priceEl);
      }
      card.appendChild(top);
    }

    const arrow = el('span', 'year-card__arrow', '›');
    arrow.setAttribute('aria-hidden', 'true');
    card.appendChild(arrow);

    return card;
  }

  function renderGrid(data) {
    const grid = document.getElementById('year-grid');
    if (!grid) return;
    grid.textContent = '';

    const years = Array.isArray(data.years) ? data.years : [];
    if (!years.length) {
      grid.appendChild(el('p', 'year-grid__status', 'No years to show.'));
      return;
    }

    const frag = document.createDocumentFragment();
    years.forEach(function (y) {
      if (y && y.year) frag.appendChild(buildYearCard(y));
    });
    grid.appendChild(frag);
  }

  function showError() {
    const grid = document.getElementById('year-grid');
    if (grid) {
      grid.textContent = '';
      grid.appendChild(el('p', 'year-grid__status', 'Could not load the year list. Please reload.'));
    }
  }

  // --- Boot ---
  fetch(DATA_URL)
    .then(function (r) {
      if (!r.ok) throw new Error('years.json HTTP ' + r.status);
      return r.json();
    })
    .then(function (data) {
      renderTagline(data);
      renderGrid(data);
    })
    .catch(function (err) {
      console.error('home: failed to load years.json', err);
      showError();
    });
})();
