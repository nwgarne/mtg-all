/*
 * year.js — MTG-by-year browser, one page per release year.
 * Reads the year from the URL path (/2024/ -> "2024"), fetches
 * /data/<year>.json, and renders every card from that year grouped
 * by type into a single-open accordion.
 *
 * Mirrors decks.dirtyshoulders.com decklist.js for the card-tile DOM,
 * the category block, and the click-to-zoom lightbox so the copied
 * card-tile.css styles this page unchanged.
 *
 * PERFORMANCE CONTRACT (a year can hold ~13,000 cards, one category
 * up to ~4,500): tiles are RENDERED ON EXPAND only. The DOM holds the
 * tiles of at most ONE category at a time. Opening a category clears
 * any other open category's body; closing a category clears its own.
 * Every card image is loading="lazy" so only on-screen images fetch.
 */
(function () {
  'use strict';

  // --- DOM helpers (match decklist.js style) ---
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

  // First clause of a type line, e.g. "Legendary Creature — Dragon" -> "Legendary Creature".
  function shortType(typeLine) {
    if (!typeLine) return '';
    var split = typeLine.split(/\s+[—\-]\s+/);
    return split[0] || typeLine;
  }

  // Thousands separators, no decimals: 12968 -> "12,968".
  function fmtInt(n) {
    if (!isFinite(n)) n = 0;
    return Math.round(n).toLocaleString('en-US');
  }
  // Whole-dollar money for the hero stat: 25127 -> "$25,127".
  function fmtMoney(n) {
    if (!isFinite(n)) n = 0;
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  // A single price string -> "$12.50" (two decimals); null/garbage -> null.
  function fmtPrice(raw) {
    if (raw == null) return null;
    var v = parseFloat(raw);
    if (!isFinite(v)) return null;
    return '$' + v.toFixed(2);
  }

  // --- Year from the URL path ---
  // "/2024/" -> "2024"; "/2024" -> "2024"; "/2024/index.html" -> "2024".
  function yearFromPath() {
    var path = '';
    try { path = window.location.pathname || ''; } catch (e) { path = ''; }
    var parts = path.split('/').filter(Boolean);
    for (var i = 0; i < parts.length; i++) {
      if (/^\d{4}$/.test(parts[i])) return parts[i];
    }
    return '';
  }

  // --- Lightbox (mirrors decklist.js: backdrop click + Escape + close button) ---
  var _lightbox = null;
  var _lightboxOpener = null;
  function ensureLightbox() {
    if (_lightbox) return _lightbox;
    var lb = el('div', 'card-lightbox');
    lb.id = 'card-lightbox';
    lb.setAttribute('role', 'dialog');
    lb.setAttribute('aria-modal', 'true');
    lb.setAttribute('aria-hidden', 'true');
    lb.setAttribute('aria-label', 'Card preview');
    var inner = el('div', 'card-lightbox__inner');
    var img = document.createElement('img');
    img.setAttribute('alt', '');
    inner.appendChild(img);
    lb.appendChild(inner);
    var close = el('button', 'card-lightbox__close', '×');
    close.setAttribute('type', 'button');
    close.setAttribute('aria-label', 'Close card preview');
    lb.appendChild(close);
    function hide() {
      lb.classList.remove('is-open');
      lb.setAttribute('aria-hidden', 'true');
      img.removeAttribute('src');
      if (_lightboxOpener && typeof _lightboxOpener.focus === 'function') {
        try { _lightboxOpener.focus(); } catch (e) {}
      }
      _lightboxOpener = null;
    }
    lb.addEventListener('click', function (ev) { if (ev.target === lb) hide(); });
    close.addEventListener('click', hide);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && lb.classList.contains('is-open')) hide();
    });
    document.body.appendChild(lb);
    _lightbox = lb;
    return lb;
  }
  function openLightbox(url, alt, opener) {
    if (!url) return;
    var lb = ensureLightbox();
    var img = lb.querySelector('img');
    img.setAttribute('src', url);
    img.setAttribute('alt', alt || '');
    lb.classList.add('is-open');
    lb.setAttribute('aria-hidden', 'false');
    _lightboxOpener = opener || (typeof document !== 'undefined' ? document.activeElement : null);
    var closeBtn = lb.querySelector('.card-lightbox__close');
    if (closeBtn) { try { closeBtn.focus(); } catch (e) {} }
  }

  // --- Card tile (mirrors decklist.js buildCardRow + .card-tile CSS) ---
  // c = { n, s, cn, t, m, r, p, pf, img, big, u }
  function buildCardTile(c) {
    var name = c.n || '';
    var row = el('div', 'card-tile');
    row.setAttribute('data-card', name);
    row.setAttribute('role', 'row');

    // Image button -> opens the zoom lightbox of the `big` image.
    var imgWrap = el('button', 'card-tile__image');
    imgWrap.setAttribute('type', 'button');
    imgWrap.setAttribute('aria-label', 'Preview ' + name + ' larger');
    var big = c.big || c.img || '';
    imgWrap.addEventListener('click', function () { openLightbox(big, name, imgWrap); });
    if (c.img) {
      var imgEl = document.createElement('img');
      imgEl.setAttribute('loading', 'lazy');
      imgEl.setAttribute('decoding', 'async');
      imgEl.setAttribute('src', c.img);
      imgEl.setAttribute('alt', name);
      imgWrap.appendChild(imgEl);
    }
    row.appendChild(imgWrap);

    // Meta column -> deep-links to the Scryfall card page (u).
    var meta;
    if (c.u) {
      meta = el('a', 'card-tile__meta');
      meta.setAttribute('href', c.u);
      meta.setAttribute('target', '_blank');
      meta.setAttribute('rel', 'noopener noreferrer');
      meta.setAttribute('aria-label', name + ' on Scryfall');
    } else {
      meta = el('div', 'card-tile__meta');
    }

    var nameCell = el('div', 'card-tile__name', name);
    nameCell.setAttribute('role', 'cell');
    meta.appendChild(nameCell);

    // Sub line: SET · #cn · Rarity (mirrors the decks meta line).
    var sub = el('div', 'card-tile__sub');
    sub.setAttribute('role', 'cell');
    var subParts = [];
    if (c.s) subParts.push(c.s.toUpperCase());
    if (c.cn) subParts.push('#' + c.cn);
    if (c.r) subParts.push(cap(c.r));
    if (!subParts.length) subParts.push('-');
    for (var i = 0; i < subParts.length; i++) {
      if (i > 0) sub.appendChild(el('span', 'sep', '·'));
      sub.appendChild(el('span', null, subParts[i]));
    }
    meta.appendChild(sub);
    row.appendChild(meta);

    // Price — shown to everyone. nonfoil "$p", foil appended when present;
    // foil-only when p is null; "-" when both are null.
    var price = el('div', 'card-tile__price');
    price.setAttribute('role', 'cell');
    price.appendChild(el('span', 'lbl', 'TCG'));
    var pStr = fmtPrice(c.p);
    var pfStr = fmtPrice(c.pf);
    var priceText;
    if (pStr && pfStr) priceText = pStr + ' · foil ' + pfStr;
    else if (pStr) priceText = pStr;
    else if (pfStr) priceText = 'foil ' + pfStr;
    else priceText = '-';
    price.appendChild(document.createTextNode(priceText));
    row.appendChild(price);

    return row;
  }

  // --- Accordion: render-on-expand, single-open ---
  // Tracks the currently open category index so opening one closes the other.
  var openIndex = -1;
  // Parallel arrays for the rendered category blocks.
  var catHeads = [];
  var catWraps = [];
  var catBodies = [];
  var catCards = [];

  function renderTilesInto(body, cards) {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < cards.length; i++) {
      frag.appendChild(buildCardTile(cards[i]));
    }
    body.appendChild(frag);
  }

  function collapse(idx) {
    if (idx < 0 || idx >= catWraps.length) return;
    catWraps[idx].classList.add('is-collapsed');
    catHeads[idx].setAttribute('aria-expanded', 'false');
    // Clear the tiles so the DOM never holds more than the single open category.
    catBodies[idx].innerHTML = '';
  }

  function expand(idx) {
    if (idx < 0 || idx >= catWraps.length) return;
    renderTilesInto(catBodies[idx], catCards[idx]);
    catWraps[idx].classList.remove('is-collapsed');
    catHeads[idx].setAttribute('aria-expanded', 'true');
  }

  function toggle(idx) {
    if (openIndex === idx) {
      // Toggle the open one shut.
      collapse(idx);
      openIndex = -1;
      return;
    }
    // Auto-collapse whatever is open, then open the requested one.
    if (openIndex !== -1) collapse(openIndex);
    expand(idx);
    openIndex = idx;
  }

  function buildCatBlock(category, idx) {
    var wrap = el('div', 'deck-cat is-collapsed');
    wrap.setAttribute('data-cat', category.name);

    var head = el('button', 'deck-cat__head');
    head.setAttribute('type', 'button');
    head.setAttribute('aria-expanded', 'false');
    head.appendChild(el('span', 'deck-cat__title', '// ' + category.name));
    var count = (category.count != null) ? category.count : (category.cards ? category.cards.length : 0);
    head.appendChild(el('span', 'deck-cat__count', fmtInt(count) + (count === 1 ? ' card' : ' cards')));
    head.appendChild(el('span', 'deck-cat__chev', '▾'));
    head.addEventListener('click', function () { toggle(idx); });
    wrap.appendChild(head);

    var body = el('div', 'deck-cat__body');
    body.setAttribute('role', 'rowgroup');
    wrap.appendChild(body);

    catHeads[idx] = head;
    catWraps[idx] = wrap;
    catBodies[idx] = body;
    catCards[idx] = category.cards || [];
    return wrap;
  }

  // --- Hero ---
  function buildHero(year, totalCards, numCats, totalValue) {
    var hero = el('section', 'hero is-readout');
    hero.setAttribute('aria-label', 'Year overview');

    var art = el('div', 'hero__art');
    art.setAttribute('aria-hidden', 'true');
    hero.appendChild(art);

    var kicker = el('div', 'hero__kicker');
    kicker.appendChild(el('span', null, 'Magic: the Gathering · by year'));
    hero.appendChild(kicker);

    var h1 = el('h1', 'hero__title');
    h1.appendChild(el('span', 'hero__title-stroke', year));
    var word = el('span', null, 'every ');
    word.appendChild(el('span', 'hero__title-accent', 'card.'));
    h1.appendChild(word);
    hero.appendChild(h1);

    var tagline = el('p', 'hero__tagline');
    tagline.appendChild(document.createTextNode('Every Magic card printed in ' + year + ', grouped by type. '));
    var back = el('a');
    back.setAttribute('href', '/');
    back.textContent = 'All years';
    tagline.appendChild(back);
    tagline.appendChild(document.createTextNode('.'));
    hero.appendChild(tagline);

    var statRow = el('div', 'stat-row');
    statRow.setAttribute('aria-label', 'Year stats');
    statRow.appendChild(statCell('Cards', fmtInt(totalCards)));
    statRow.appendChild(statCell('Categories', fmtInt(numCats)));
    statRow.appendChild(statCell('Nonfoil value', fmtMoney(totalValue)));
    hero.appendChild(statRow);

    return hero;
  }
  function statCell(label, value) {
    var cell = el('div', 'stat-row__cell');
    cell.appendChild(el('span', 'stat-row__label', label));
    cell.appendChild(el('span', 'stat-row__value', value));
    return cell;
  }

  // --- Empty / error state ---
  function renderEmpty(host, year) {
    host.innerHTML = '';
    var hero = el('section', 'hero is-readout');
    var kicker = el('div', 'hero__kicker');
    kicker.appendChild(el('span', null, 'Magic: the Gathering · by year'));
    hero.appendChild(kicker);
    var h1 = el('h1', 'hero__title');
    h1.appendChild(el('span', 'hero__title-stroke', 'YEAR'));
    h1.appendChild(el('span', null, year || '—'));
    hero.appendChild(h1);
    host.appendChild(hero);

    var note = el('section', 'year-empty');
    var p = el('p', 'year-empty__msg', 'No cards for ' + (year || 'this year') + '.');
    note.appendChild(p);
    var back = el('a', 'btn');
    back.setAttribute('href', '/');
    back.textContent = 'Back to all years';
    note.appendChild(back);
    host.appendChild(note);
  }

  // --- Render ---
  function render(host, year, data) {
    var categories = (data && Array.isArray(data.categories)) ? data.categories : [];
    if (!categories.length) { renderEmpty(host, year); return; }

    // Totals: total cards (trust data.totalCards, else sum counts) and the
    // year's nonfoil market value (sum each card's `p`).
    var totalValue = 0;
    var summedCount = 0;
    for (var i = 0; i < categories.length; i++) {
      var cards = categories[i].cards || [];
      summedCount += (categories[i].count != null) ? categories[i].count : cards.length;
      for (var j = 0; j < cards.length; j++) {
        var v = parseFloat(cards[j].p);
        if (isFinite(v)) totalValue += v;
      }
    }
    var totalCards = (data.totalCards != null) ? data.totalCards : summedCount;

    host.innerHTML = '';
    host.appendChild(buildHero(year, totalCards, categories.length, totalValue));

    var grid = el('div', 'deck-grid');
    grid.id = 'year-grid';
    for (var k = 0; k < categories.length; k++) {
      grid.appendChild(buildCatBlock(categories[k], k));
    }
    host.appendChild(grid);
  }

  // --- Boot ---
  function boot() {
    var host = document.getElementById('year-root');
    if (!host) { host = document.querySelector('[data-year-root]'); }
    if (!host) { console.warn('year: no #year-root host found'); return; }

    var year = yearFromPath();
    if (!year) { renderEmpty(host, ''); return; }

    document.title = year + ' · MTG by year';

    fetch('/data/' + year + '.json', { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) {
          // 404 (or other non-2xx): friendly empty state.
          if (r.status === 404) return null;
          throw new Error('HTTP ' + r.status);
        }
        return r.json();
      })
      .then(function (data) {
        if (!data) { renderEmpty(host, year); return; }
        render(host, year, data);
      })
      .catch(function (err) {
        console.error('year: failed to load', err);
        renderEmpty(host, year);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
