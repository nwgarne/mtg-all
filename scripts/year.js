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
 *
 * CONTROLS (rendered from JS, under the hero, above the accordion):
 *   - Set scope: "All cards" or one set code; filters every category
 *     to card.s === code, dropping categories that empty out.
 *   - Sort: reorders cards WITHIN each type section (Name / Price /
 *     Rarity / Mana value) without ever reordering the sections.
 * Changing either re-derives the categories (filter on the FULL
 * arrays, then sort) and re-renders the accordion. Render-on-expand
 * is preserved: only the open category's tiles ever touch the DOM.
 * All wiring is addEventListener (CSP: script-src 'self', no inline).
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

  // Max market price of a card across nonfoil + foil; 0 when neither.
  function cardMaxPrice(c) {
    var p = parseFloat(c.p);
    var pf = parseFloat(c.pf);
    var a = isFinite(p) ? p : 0;
    var b = isFinite(pf) ? pf : 0;
    return a > b ? a : b;
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
  // c = { n, s, cn, t, m, c, r, p, pf, img, big, u }  (c here = mana value)
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

  // ============================================================
  //  FILTER + SORT
  //  These run over the FULL category card arrays (the source of
  //  truth held in `baseCats`). They produce the derived category
  //  arrays the accordion is built from. Tiles are still only
  //  rendered on expand, so this touches plain objects, not DOM.
  // ============================================================

  // Rarity rank, descending priority: mythic > rare > uncommon > common > other.
  var RARITY_RANK = { mythic: 4, rare: 3, uncommon: 2, common: 1 };
  function rarityRank(r) {
    if (!r) return 0;
    var v = RARITY_RANK[String(r).toLowerCase()];
    return v || 0;
  }

  // Case-insensitive name compare, used directly and as every tie-break.
  function byName(a, b) {
    var an = (a.n || '').toLowerCase();
    var bn = (b.n || '').toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  }

  // Comparator factory keyed by the sort <select> value.
  function comparatorFor(sortKey) {
    if (sortKey === 'price') {
      // Max price high -> low; no-price (0) sinks to the bottom; tie-break name.
      return function (a, b) {
        var pa = cardMaxPrice(a);
        var pb = cardMaxPrice(b);
        if (pa !== pb) return pb - pa;
        return byName(a, b);
      };
    }
    if (sortKey === 'rarity') {
      // Rarity high -> low; tie-break name.
      return function (a, b) {
        var ra = rarityRank(a.r);
        var rb = rarityRank(b.r);
        if (ra !== rb) return rb - ra;
        return byName(a, b);
      };
    }
    if (sortKey === 'cmc') {
      // Mana value low -> high; cards without a numeric value sink; tie-break name.
      return function (a, b) {
        var ca = (typeof a.c === 'number' && isFinite(a.c)) ? a.c : Infinity;
        var cb = (typeof b.c === 'number' && isFinite(b.c)) ? b.c : Infinity;
        if (ca !== cb) return ca - cb;
        return byName(a, b);
      };
    }
    // Default: Name A-Z.
    return byName;
  }

  // Build the derived categories for the current scope + sort.
  //   scope === '' -> all cards; otherwise keep only card.s === scope.
  //   Empty categories are dropped. Each kept category gets a sorted
  //   COPY of its cards (the base arrays are never mutated) and a count
  //   reflecting the filtered length.
  function deriveCategories(baseCats, scope, sortKey) {
    var cmp = comparatorFor(sortKey);
    var out = [];
    for (var i = 0; i < baseCats.length; i++) {
      var cat = baseCats[i];
      var src = cat.cards || [];
      var cards;
      if (scope) {
        cards = [];
        for (var j = 0; j < src.length; j++) {
          if (src[j].s === scope) cards.push(src[j]);
        }
        if (!cards.length) continue; // drop categories that empty out
      } else {
        cards = src.slice(); // copy so the sort never reorders the base array
      }
      cards.sort(cmp);
      out.push({ name: cat.name, cards: cards, count: cards.length });
    }
    return out;
  }

  // --- Accordion: render-on-expand, single-open ---
  // State for the current derived render. Parallel arrays for the
  // rendered category blocks; openName tracks which category (by name,
  // so it survives a re-derive) is open across scope/sort changes.
  var openName = null;
  var catHeads = [];
  var catWraps = [];
  var catBodies = [];
  var catCards = [];
  var catNames = [];

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

  // Find the index of the currently open category, or -1.
  function openIndex() {
    if (openName == null) return -1;
    for (var i = 0; i < catNames.length; i++) {
      if (catNames[i] === openName) return i;
    }
    return -1;
  }

  function toggle(idx) {
    var cur = openIndex();
    if (cur === idx) {
      // Toggle the open one shut.
      collapse(idx);
      openName = null;
      return;
    }
    // Auto-collapse whatever is open, then open the requested one.
    if (cur !== -1) collapse(cur);
    expand(idx);
    openName = catNames[idx];
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
    catNames[idx] = category.name;
    return wrap;
  }

  // (Re)build the accordion grid from a derived-categories array into
  // `gridEl`. Preserves the render-on-expand + one-open invariant: if
  // the previously-open category still exists it is reopened (and only
  // its tiles are rendered); otherwise everything stays collapsed.
  function renderAccordion(gridEl, derivedCats) {
    // Reset the parallel-array bookkeeping for the fresh block set.
    catHeads = [];
    catWraps = [];
    catBodies = [];
    catCards = [];
    catNames = [];

    gridEl.innerHTML = '';
    if (!derivedCats.length) {
      // Every category filtered out under this scope: friendly inline note.
      openName = null;
      var note = el('p', 'year-controls__empty',
        'No cards in this set for the current view.');
      gridEl.appendChild(note);
      return;
    }

    for (var k = 0; k < derivedCats.length; k++) {
      gridEl.appendChild(buildCatBlock(derivedCats[k], k));
    }

    // Re-open the same category by name if it survived the re-derive.
    var reopen = openIndex();
    if (reopen !== -1) {
      expand(reopen); // renders only this one category's tiles
    } else {
      openName = null;
    }
  }

  // --- Controls (Set scope + Sort) ---
  // Rendered between the hero and the accordion. Both are <select>s
  // wired with addEventListener; changing either re-derives + repaints.
  var SORT_OPTIONS = [
    { value: 'name', label: 'Name (A-Z)' },
    { value: 'price', label: 'Price (high to low)' },
    { value: 'rarity', label: 'Rarity' },
    { value: 'cmc', label: 'Mana value (low to high)' }
  ];

  function buildControls(state, onChange) {
    var bar = el('div', 'year-controls');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'View controls');

    // -- SET scope --
    var setField = el('label', 'year-controls__field');
    setField.appendChild(el('span', 'year-controls__label', 'Set'));
    var setSel = el('select', 'year-controls__select');
    setSel.setAttribute('aria-label', 'Filter by set');

    var allOpt = el('option', null, 'All cards (' + fmtInt(state.totalCards) + ')');
    allOpt.value = '';
    setSel.appendChild(allOpt);
    for (var i = 0; i < state.sets.length; i++) {
      var s = state.sets[i];
      var code = s.code || '';
      // "Name (CODE) - count"  (hyphen, never an em dash)
      var optLabel = (s.name || code) + ' (' + String(code).toUpperCase() + ') - ' + fmtInt(s.count);
      var opt = el('option', null, optLabel);
      opt.value = code;
      setSel.appendChild(opt);
    }
    setSel.value = state.scope;
    setSel.addEventListener('change', function () {
      state.scope = setSel.value;
      onChange();
    });
    setField.appendChild(setSel);
    bar.appendChild(setField);

    // -- SORT --
    var sortField = el('label', 'year-controls__field');
    sortField.appendChild(el('span', 'year-controls__label', 'Sort'));
    var sortSel = el('select', 'year-controls__select');
    sortSel.setAttribute('aria-label', 'Sort cards within each type');
    for (var k = 0; k < SORT_OPTIONS.length; k++) {
      var so = SORT_OPTIONS[k];
      var sopt = el('option', null, so.label);
      sopt.value = so.value;
      sortSel.appendChild(sopt);
    }
    sortSel.value = state.sort;
    sortSel.addEventListener('change', function () {
      state.sort = sortSel.value;
      onChange();
    });
    sortField.appendChild(sortSel);
    bar.appendChild(sortField);

    return bar;
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

    // Source of truth: the full, unsorted category arrays + the sets list.
    var baseCats = categories;
    var sets = (data && Array.isArray(data.sets)) ? data.sets : [];

    // Live view state; defaults = all cards, name A-Z.
    var state = { scope: '', sort: 'name', totalCards: totalCards, sets: sets };
    openName = null;

    host.innerHTML = '';
    // Hero shows the year-wide totals regardless of the active scope.
    host.appendChild(buildHero(year, totalCards, baseCats.length, totalValue));

    var grid = el('div', 'deck-grid');
    grid.id = 'year-grid';

    // re-derive + repaint the accordion for the current state.
    function apply() {
      var derived = deriveCategories(baseCats, state.scope, state.sort);
      renderAccordion(grid, derived);
    }

    host.appendChild(buildControls(state, apply));
    host.appendChild(grid);

    // First paint: all cards, name A-Z, everything collapsed.
    apply();
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
