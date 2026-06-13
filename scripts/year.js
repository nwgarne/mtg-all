/*
 * year.js - MTG-by-year browser, one page per release year.
 * Reads the year from the URL path (/2024/ -> "2024"), fetches
 * /data/<year>.json, and renders every card from that year.
 *
 * TWO VIEWS, routed by the URL hash:
 *   - PICKER (no hash): a grid of "deck" cards (the same .year-card look
 *     as the homepage). An "All cards" card plus one per `sets` entry.
 *   - SCOPE  (#all or #<setcode>): that scope's type accordion under a
 *     sticky toolbar (back button + scope label + sort + type jump-pills),
 *     with a floating back-to-top button.
 * Reading location.hash on load chooses the initial view; a hashchange
 * listener swaps views, so the browser Back button works and views are
 * shareable.
 *
 * Mirrors decks.dirtyshoulders.com decklist.js for the card-tile DOM,
 * the category block, and the click-to-zoom lightbox so the copied
 * card-tile.css styles this page unchanged.
 *
 * PERFORMANCE CONTRACT (a year can hold ~13,000 cards, one category
 * up to ~4,500): tiles are RENDERED ON EXPAND only. The DOM holds the
 * tiles of at most ONE category at a time. Opening a category clears
 * any other open category's body; collapsing a category clears its own;
 * leaving the scope view (back to the picker) tears the accordion down.
 * Every card image is loading="lazy" so only on-screen images fetch.
 *
 * SCOPE TOOLBAR (sticky, in the scope view only):
 *   - "← Sets" clears the hash, returning to the picker.
 *   - Scope label ("All cards" or "<Set name> - <n> cards").
 *   - Sort <select>: reorders cards WITHIN each type section (Name /
 *     Price / Rarity / Mana value) without ever reordering the sections.
 *   - Type jump-pills: one per non-empty type; opens + scrolls to it.
 * Changing sort re-derives the categories (filter on the FULL arrays,
 * then sort) and re-renders the accordion. Render-on-expand is preserved:
 * only the open category's tiles ever touch the DOM.
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

  // First clause of a type line (the part before the dash separator); yields e.g. "Legendary Creature".
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
  // Whole-dollar price for the set-card caption: 2299.99 -> "$2,300"; junk -> ''.
  function fmtWhole(raw) {
    if (raw == null) return '';
    var v = parseFloat(raw);
    if (!isFinite(v)) return '';
    return '$' + Math.round(v).toLocaleString('en-US');
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
  // Supports one OR two faces: a double-faced card (back image in `b2`)
  // shows front + back together; single image otherwise.
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
    // The inner holds one or two <img>; CSS lays the pair side by side
    // on desktop and stacks them on narrow screens.
    var inner = el('div', 'card-lightbox__inner');
    lb.appendChild(inner);
    var close = el('button', 'card-lightbox__close', '×');
    close.setAttribute('type', 'button');
    close.setAttribute('aria-label', 'Close card preview');
    lb.appendChild(close);
    function hide() {
      lb.classList.remove('is-open');
      lb.setAttribute('aria-hidden', 'true');
      // Drop the images so nothing keeps fetching/decoding while closed.
      inner.textContent = '';
      lb.classList.remove('is-dfc');
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
  function lightboxImg(src, alt) {
    var img = document.createElement('img');
    img.setAttribute('src', src);
    img.setAttribute('alt', alt || '');
    return img;
  }
  // front = the `big` image; back = the optional `b2` image.
  function openLightbox(front, back, name, opener) {
    if (!front && !back) return;
    var lb = ensureLightbox();
    var inner = lb.querySelector('.card-lightbox__inner');
    inner.textContent = '';
    if (front) inner.appendChild(lightboxImg(front, name ? name + ' (front)' : ''));
    if (back) {
      inner.appendChild(lightboxImg(back, name ? name + ' (back)' : ''));
      lb.classList.add('is-dfc');
    } else {
      lb.classList.remove('is-dfc');
    }
    lb.classList.add('is-open');
    lb.setAttribute('aria-hidden', 'false');
    _lightboxOpener = opener || (typeof document !== 'undefined' ? document.activeElement : null);
    var closeBtn = lb.querySelector('.card-lightbox__close');
    if (closeBtn) { try { closeBtn.focus(); } catch (e) {} }
  }

  // --- Card tile (mirrors decklist.js buildCardRow + .card-tile CSS) ---
  // c = { n, s, cn, t, m, c, r, p, pf, img, big, b2, u }  (c here = mana value)
  function buildCardTile(c) {
    var name = c.n || '';
    var row = el('div', 'card-tile');
    row.setAttribute('data-card', name);
    row.setAttribute('role', 'row');

    // Image button -> opens the zoom lightbox (front, plus back when `b2`).
    var imgWrap = el('button', 'card-tile__image');
    imgWrap.setAttribute('type', 'button');
    var dfc = !!c.b2;
    imgWrap.setAttribute('aria-label',
      'Preview ' + name + ' larger' + (dfc ? ' (front and back)' : ''));
    var big = c.big || c.img || '';
    var back = c.b2 || '';
    imgWrap.addEventListener('click', function () { openLightbox(big, back, name, imgWrap); });
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

    // Price - shown to everyone. nonfoil "$p", foil appended when present;
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
  // so it survives a re-derive) is open across sort changes.
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

  // Scroll so category idx's header parks just under the sticky toolbar.
  // scroll-margin-top on the header (= the combined sticky offset) does
  // the spacing; this fires after the expand paints.
  function scrollToCat(idx) {
    if (idx < 0 || idx >= catWraps.length) return;
    // Measure the .deck-cat WRAP, not the header. The header is position:sticky,
    // so once you have scrolled past it getBoundingClientRect() returns its PINNED
    // offset (the sticky top), not its natural document position - scrolling there
    // is a no-op and leaves the section's cards a full screen above the viewport.
    // The wrap is static, so its rect IS the natural position. Collapsing the
    // previous (multi-screen) section shrinks the document and clamps scroll to the
    // bottom, so compute the absolute target live and force an INSTANT scroll
    // (global CSS sets scroll-behavior:smooth, which would animate across the whole
    // document height and lose the target).
    var wrap = catWraps[idx];
    if (!wrap) return;
    var doScroll = function () {
      var off = stickyOffsetPx();
      var top = wrap.getBoundingClientRect().top +
                (window.pageYOffset || document.documentElement.scrollTop || 0);
      var y = Math.max(0, Math.round(top - off - 4));
      // Force an INSTANT jump. Global CSS sets scroll-behavior:smooth, and a
      // scrollTo behavior of 'auto' (and the legacy 2-arg form) RESOLVE to that
      // smooth - animating across the whole document height and never arriving
      // inside one interaction. Pin scroll-behavior:auto on <html> for the jump
      // (explicit 'smooth' callers like back-to-top are unaffected), then restore.
      var rs = document.documentElement.style;
      var prev = rs.scrollBehavior;
      rs.scrollBehavior = 'auto';
      try { window.scrollTo({ top: y, left: 0, behavior: 'instant' }); }
      catch (e) { window.scrollTo(0, y); }
      rs.scrollBehavior = prev;
    };
    doScroll();                          // immediate: scroll before the clamped-bottom frame paints
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(doScroll);   // re-assert after the reflow / scroll-anchoring settles
    }
  }

  function toggle(idx, scroll) {
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
    if (scroll) scrollToCat(idx);
  }

  // Open category idx (used by the jump-pills); never toggles shut, and
  // always scrolls its header to the top.
  function openCat(idx) {
    var cur = openIndex();
    if (cur === idx) { scrollToCat(idx); return; }
    if (cur !== -1) collapse(cur);
    expand(idx);
    openName = catNames[idx];
    scrollToCat(idx);
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
    head.addEventListener('click', function () { toggle(idx, true); });
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
      // Empty scope: friendly inline note.
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

  // ============================================================
  //  STICKY OFFSET COORDINATION
  //  The top header (.mtg-topbar) is sticky at top:0; the scope
  //  toolbar parks just under it; section headers park under both.
  //  We measure both live heights and publish them as CSS vars so
  //  the toolbar `top`, the header `top`, and the scroll-into-view
  //  margin all share one source of truth.
  //    --mtg-topbar-h : the header height
  //    --toolbar-h    : the header + scope-toolbar height (the full
  //                     sticky stack a section header must clear)
  // ============================================================
  var _topbarEl = null;
  var _toolbarEl = null;

  function topbarHeightPx() {
    if (!_topbarEl) _topbarEl = document.querySelector('.mtg-topbar');
    return _topbarEl ? Math.round(_topbarEl.getBoundingClientRect().height) : 56;
  }
  function toolbarHeightPx() {
    return _toolbarEl ? Math.round(_toolbarEl.getBoundingClientRect().height) : 0;
  }
  // The full sticky stack height a section header has to clear.
  function stickyOffsetPx() {
    return topbarHeightPx() + toolbarHeightPx();
  }

  function syncStickyVars() {
    var root = document.documentElement;
    var tb = topbarHeightPx();
    root.style.setProperty('--mtg-topbar-h', tb + 'px');
    root.style.setProperty('--toolbar-h', (tb + toolbarHeightPx()) + 'px');
  }

  // Keep the vars current as the toolbar reflows (wraps on resize).
  var _ro = null;
  function watchToolbar(toolbar) {
    _toolbarEl = toolbar;
    syncStickyVars();
    if (_ro) { try { _ro.disconnect(); } catch (e) {} _ro = null; }
    if (toolbar && typeof ResizeObserver !== 'undefined') {
      _ro = new ResizeObserver(function () { syncStickyVars(); });
      try { _ro.observe(toolbar); } catch (e) {}
      try { _ro.observe(document.querySelector('.mtg-topbar')); } catch (e) {}
    }
  }
  function unwatchToolbar() {
    if (_ro) { try { _ro.disconnect(); } catch (e) {} _ro = null; }
    _toolbarEl = null;
    var root = document.documentElement;
    // Leave --mtg-topbar-h alone; just zero the toolbar contribution.
    root.style.setProperty('--toolbar-h', topbarHeightPx() + 'px');
  }
  // One window resize listener (added once) re-measures whatever is live.
  window.addEventListener('resize', function () { syncStickyVars(); });

  // --- Sort options (shared by the scope toolbar) ---
  var SORT_OPTIONS = [
    { value: 'name', label: 'Name (A-Z)' },
    { value: 'price', label: 'Price (high to low)' },
    { value: 'rarity', label: 'Rarity' },
    { value: 'cmc', label: 'Mana value (low to high)' }
  ];

  // ============================================================
  //  BACK-TO-TOP BUTTON (floating; scope view only)
  //  Appears after scrolling down, scrolls back to the top.
  // ============================================================
  var _toTop = null;
  var _onScrollToTop = null;
  function ensureBackToTop() {
    if (_toTop) return _toTop;
    var btn = el('button', 'year-totop', '↑');
    btn.setAttribute('type', 'button');
    btn.setAttribute('aria-label', 'Back to top');
    btn.addEventListener('click', function () {
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); }
      catch (e) { window.scrollTo(0, 0); }
    });
    document.body.appendChild(btn);
    _toTop = btn;
    return btn;
  }
  function showBackToTop() {
    var btn = ensureBackToTop();
    function update() {
      var y = window.pageYOffset || document.documentElement.scrollTop || 0;
      if (y > 400) btn.classList.add('is-visible');
      else btn.classList.remove('is-visible');
    }
    _onScrollToTop = update;
    window.addEventListener('scroll', update, { passive: true });
    update();
  }
  function hideBackToTop() {
    if (_onScrollToTop) {
      window.removeEventListener('scroll', _onScrollToTop);
      _onScrollToTop = null;
    }
    if (_toTop) _toTop.classList.remove('is-visible');
  }

  // ============================================================
  //  HASH ROUTING
  //  ''        -> picker (set cards)
  //  '#all'    -> all-cards accordion (scope = '')
  //  '#<code>' -> that set's accordion (scope = code)
  //  A set code is matched case-insensitively against the sets list;
  //  anything unknown falls back to the picker.
  // ============================================================
  function readHash() {
    var h = '';
    try { h = (window.location.hash || '').replace(/^#/, ''); } catch (e) { h = ''; }
    return h;
  }
  function setHash(h) {
    // Assign through location.hash so it pushes a history entry (Back works).
    try { window.location.hash = h ? ('#' + h) : ''; } catch (e) {}
  }
  function clearHash() {
    // Remove the hash without leaving a bare "#": pushState when available
    // so Back returns to the previous in-page view; else assign empty hash.
    if (window.history && typeof window.history.pushState === 'function') {
      try {
        var url = window.location.pathname + window.location.search;
        window.history.pushState(null, '', url);
        // pushState never fires hashchange, so the router would not re-render
        // and the picker would never come back. Dispatch one so showView runs.
        window.dispatchEvent(new Event('hashchange'));
        return;
      } catch (e) {}
    }
    try { window.location.hash = ''; } catch (e) {}
  }

  // --- Hero (year + stat row), shared by both views ---
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
    statRow.appendChild(statCell('Sets', fmtInt(numCats)));
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

  // ============================================================
  //  PICKER VIEW - the set cards grid (replaces the Set dropdown)
  //  Built to the homepage .year-card look (reused via home.css).
  //  First card "All cards"; then one card per `sets` entry. Clicking
  //  a card sets the hash, which the hashchange handler turns into the
  //  matching scope view.
  // ============================================================
  // Inline background-image is the one inline style CSP permits. Wrap in
  // quotes and strip quote/backslash chars so stray data can't break out.
  function setBgImage(node, url) {
    if (!url) { node.classList.add('is-plain'); return; }
    var safe = String(url).replace(/["'\\]/g, '');
    node.setAttribute('style', "background-image:url('" + safe + "')");
  }

  function buildPickerCard(opts) {
    // opts: { hash, year, counts(text), title(text), code(text|null),
    //         art, topName, topValue, ariaLabel }
    var card = el('a', 'year-card');
    card.setAttribute('href', '#' + opts.hash);
    card.setAttribute('aria-label', opts.ariaLabel);
    setBgImage(card, opts.art);

    // Top rail: the card count (and set code when present).
    var counts = el('div', 'year-card__counts');
    counts.appendChild(el('strong', null, fmtInt(opts.count)));
    counts.appendChild(document.createTextNode(opts.count === 1 ? ' card' : ' cards'));
    if (opts.code) {
      counts.appendChild(el('span', 'sep', '·'));
      counts.appendChild(el('strong', null, '(' + opts.code + ')'));
    }
    card.appendChild(counts);

    // The big title: "All cards" or the set NAME.
    var titleEl = el('div', 'year-card__year year-card__set-name');
    titleEl.textContent = opts.title;
    titleEl.setAttribute('title', opts.title);
    card.appendChild(titleEl);

    // Caption: "Top: <name> - $<value>" (hyphen, no em dash).
    if (opts.topName) {
      var top = el('div', 'year-card__top');
      top.appendChild(el('span', 'year-card__top-lbl', 'Top:'));
      var nameEl = el('span', 'year-card__top-name', opts.topName);
      nameEl.setAttribute('title', opts.topName);
      top.appendChild(nameEl);
      var whole = fmtWhole(opts.topValue);
      if (whole) {
        top.appendChild(el('span', 'sep', '-'));
        top.appendChild(el('span', 'year-card__top-price', whole));
      }
      card.appendChild(top);
    }

    var arrow = el('span', 'year-card__arrow', '›');
    arrow.setAttribute('aria-hidden', 'true');
    card.appendChild(arrow);

    // Clicking sets the hash (default <a href="#..."> already does, but
    // be explicit so it works even if default is ever prevented upstream).
    card.addEventListener('click', function (ev) {
      // Let modified clicks (new tab) behave normally.
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault();
      setHash(opts.hash);
    });

    return card;
  }

  function renderPicker(ctx) {
    var grid = el('div', 'year-grid');
    grid.id = 'year-set-grid';

    var frag = document.createDocumentFragment();

    // "All cards" card first: the year total, scope = all.
    frag.appendChild(buildPickerCard({
      hash: 'all',
      count: ctx.totalCards,
      title: 'All cards',
      code: null,
      art: ctx.heroArt,
      topName: ctx.heroTopName,
      topValue: ctx.heroTopValue,
      ariaLabel: 'All cards, ' + fmtInt(ctx.totalCards) + ' cards in ' + ctx.year
    }));

    // One card per set (already sorted by count in the data).
    for (var i = 0; i < ctx.sets.length; i++) {
      var s = ctx.sets[i];
      var code = (s.code || '').toUpperCase();
      frag.appendChild(buildPickerCard({
        hash: (s.code || '').toLowerCase(),
        count: s.count || 0,
        title: s.name || code || 'Set',
        code: code,
        art: s.art,
        topName: s.top,
        topValue: s.value,
        ariaLabel: (s.name || code) + ' (' + code + '), ' + fmtInt(s.count || 0) +
          ' cards' + (s.top ? ', top card ' + s.top : '')
      }));
    }
    grid.appendChild(frag);
    return grid;
  }

  // ============================================================
  //  SCOPE VIEW - sticky toolbar + the type accordion
  // ============================================================
  function buildToolbar(ctx, state, derived, onSortChange) {
    var bar = el('div', 'year-toolbar');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Scope controls');

    // Row 1: back button + scope label + sort.
    var topRow = el('div', 'year-toolbar__row');

    var back = el('button', 'year-toolbar__back');
    back.setAttribute('type', 'button');
    back.appendChild(el('span', 'year-toolbar__back-arrow', '←'));
    back.appendChild(document.createTextNode(' Sets'));
    back.setAttribute('aria-label', 'Back to set cards');
    back.addEventListener('click', function () { clearHash(); });
    topRow.appendChild(back);

    // Scope label: "All cards" or "<Set name> - <n> cards".
    var label = el('div', 'year-toolbar__label');
    if (state.scope) {
      label.textContent = (ctx.setName(state.scope) || state.scope.toUpperCase()) +
        ' - ' + fmtInt(ctx.scopeCount(state.scope)) + ' cards';
    } else {
      label.textContent = 'All cards - ' + fmtInt(ctx.totalCards) + ' cards';
    }
    topRow.appendChild(label);

    // Sort select.
    var sortField = el('label', 'year-toolbar__sort');
    sortField.appendChild(el('span', 'year-toolbar__sort-lbl', 'Sort'));
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
      onSortChange();
    });
    sortField.appendChild(sortSel);
    topRow.appendChild(sortField);

    bar.appendChild(topRow);

    // Row 2: type jump-pills (one per non-empty type in this scope).
    if (derived.length) {
      var pills = el('div', 'year-toolbar__pills');
      pills.setAttribute('aria-label', 'Jump to type');
      for (var i = 0; i < derived.length; i++) {
        (function (idx, cat) {
          var pill = el('button', 'year-pill');
          pill.setAttribute('type', 'button');
          pill.appendChild(el('span', 'year-pill__name', cat.name));
          pill.appendChild(el('span', 'year-pill__n', fmtInt(cat.count)));
          pill.setAttribute('aria-label',
            'Jump to ' + cat.name + ' (' + fmtInt(cat.count) + ' cards)');
          pill.addEventListener('click', function () { openCat(idx); });
          pills.appendChild(pill);
        })(i, derived[i]);
      }
      bar.appendChild(pills);
    }

    return bar;
  }

  function renderScope(ctx, host, state) {
    host.innerHTML = '';
    host.appendChild(ctx.hero);

    var grid = el('div', 'deck-grid');
    grid.id = 'year-grid';

    var toolbarHolder = { bar: null };

    // Re-derive + repaint the accordion (and rebuild the toolbar pills,
    // since the non-empty type set can change with scope - though within
    // a single scope view only the sort changes, the pills are stable).
    function apply() {
      // Remember the chosen sort so it carries to the next scope this session.
      ctx.lastSort = state.sort;
      var derived = deriveCategories(ctx.baseCats, state.scope, state.sort);
      // Rebuild the toolbar so the jump-pills reflect the live derived set.
      var newBar = buildToolbar(ctx, state, derived, apply);
      if (toolbarHolder.bar && toolbarHolder.bar.parentNode) {
        toolbarHolder.bar.parentNode.replaceChild(newBar, toolbarHolder.bar);
      } else {
        host.insertBefore(newBar, grid);
      }
      toolbarHolder.bar = newBar;
      watchToolbar(newBar);
      renderAccordion(grid, derived);
    }

    host.appendChild(grid);
    apply();

    showBackToTop();
  }

  // ============================================================
  //  VIEW ROUTER
  // ============================================================
  function resolveScope(ctx, hash) {
    // Returns { kind: 'picker' } | { kind: 'scope', scope: '' | code }.
    if (!hash) return { kind: 'picker' };
    if (hash === 'all') return { kind: 'scope', scope: '' };
    var code = ctx.matchSet(hash);
    if (code != null) return { kind: 'scope', scope: code };
    // Unknown hash: fall back to the picker.
    return { kind: 'picker' };
  }

  function showView(ctx, host) {
    var route = resolveScope(ctx, readHash());
    if (route.kind === 'picker') {
      // Tear down any scope-view chrome.
      unwatchToolbar();
      hideBackToTop();
      openName = null;
      host.innerHTML = '';
      host.appendChild(ctx.hero);
      host.appendChild(renderPicker(ctx));
      // Reset scroll to the top so the picker starts at the hero.
      try { window.scrollTo(0, 0); } catch (e) {}
    } else {
      // Scope view. Reset the open category whenever the scope changes.
      if (ctx.lastScope !== route.scope) {
        openName = null;
        ctx.lastScope = route.scope;
      }
      var state = { scope: route.scope, sort: ctx.lastSort || 'name' };
      renderScope(ctx, host, state);
      // Land at the top of the new scope view.
      try { window.scrollTo(0, 0); } catch (e) {}
    }
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
    h1.appendChild(el('span', null, year || '-'));
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

  // --- Render (builds the shared context, then routes to a view) ---
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

    var sets = (data && Array.isArray(data.sets)) ? data.sets : [];

    // Per-set lookups used by the toolbar label + scope routing.
    var setByCode = {};       // upperCode -> set object
    for (var s = 0; s < sets.length; s++) {
      var c = (sets[s].code || '').toUpperCase();
      if (c) setByCode[c] = sets[s];
    }
    function setName(scope) {
      var hit = setByCode[(scope || '').toUpperCase()];
      return hit ? (hit.name || scope) : null;
    }
    function scopeCount(scope) {
      var hit = setByCode[(scope || '').toUpperCase()];
      return hit && hit.count != null ? hit.count : 0;
    }
    // Match a hash (any case) to a real set code; returns the data's
    // canonical (lowercase, as stored on cards) code, or null.
    function matchSet(hash) {
      var hit = setByCode[(hash || '').toUpperCase()];
      return hit ? (hit.code || '') : null;
    }

    // The hero card art for the "All cards" picker tile = the top set's
    // top-card art (sets are sorted by count, so [0] is the biggest set;
    // its art is a sensible, on-theme cover). Fall back to none.
    var heroSet = sets.length ? sets[0] : null;

    // Build the shared hero ONCE and reuse the same node across views.
    var hero = buildHero(year, totalCards, sets.length, totalValue);

    var ctx = {
      year: year,
      baseCats: categories,
      sets: sets,
      totalCards: totalCards,
      hero: hero,
      heroArt: heroSet ? heroSet.art : '',
      heroTopName: heroSet ? heroSet.top : '',
      heroTopValue: heroSet ? heroSet.value : null,
      setName: setName,
      scopeCount: scopeCount,
      matchSet: matchSet,
      lastScope: undefined,
      lastSort: 'name'
    };

    openName = null;
    host.innerHTML = '';

    // Route to the initial view from the current hash, then keep both the
    // browser Back button and shared links working via hashchange.
    showView(ctx, host);
    window.addEventListener('hashchange', function () { showView(ctx, host); });
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
