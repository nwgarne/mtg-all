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
  // A single price string -> "$12.50" (two decimals, thousands grouped:
  // 2249.99 -> "$2,249.99"); null/garbage -> null. Grouping matches the
  // hero stat + the homepage caption so big prices read consistently (Item 7).
  function fmtPrice(raw) {
    if (raw == null) return null;
    var v = parseFloat(raw);
    if (!isFinite(v)) return null;
    return '$' + v.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
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
    // Collect the lightbox's own focusable elements (the images are not
    // focusable, so in practice this is the close button; written generally
    // so it still works if a focusable control is ever added inside).
    function focusables() {
      var nodes = lb.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      var out = [];
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.disabled) continue;
        if (n.getAttribute('aria-hidden') === 'true') continue;
        out.push(n);
      }
      return out;
    }
    document.addEventListener('keydown', function (ev) {
      if (!lb.classList.contains('is-open')) return;
      if (ev.key === 'Escape') { hide(); return; }
      // Trap Tab / Shift+Tab inside the open modal so focus cannot walk into
      // the background (aria-modal alone does not enforce this) (a11y audit).
      if (ev.key === 'Tab' || ev.keyCode === 9) {
        var f = focusables();
        if (!f.length) { ev.preventDefault(); return; }
        var first = f[0];
        var last = f[f.length - 1];
        var active = document.activeElement;
        // If focus has somehow escaped the lightbox, pull it back in.
        if (!lb.contains(active)) {
          ev.preventDefault();
          (ev.shiftKey ? last : first).focus();
          return;
        }
        if (ev.shiftKey && active === first) {
          ev.preventDefault();
          last.focus();
        } else if (!ev.shiftKey && active === last) {
          ev.preventDefault();
          first.focus();
        }
      }
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
  // Foil-tilt: the zoomed card catches the light on pointer-move, the iconic
  // "foil in the light" feel. Off entirely under reduced motion.
  var _reduceMotion = (typeof window !== 'undefined' && window.matchMedia)
    ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function attachFoil(foil) {
    if (_reduceMotion && _reduceMotion.matches) return;
    var MAXT = 9;
    foil.addEventListener('pointermove', function (e) {
      var r = foil.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var px = (e.clientX - r.left) / r.width;
      var py = (e.clientY - r.top) / r.height;
      foil.style.setProperty('--rx', ((px - 0.5) * 2 * MAXT).toFixed(2) + 'deg');
      foil.style.setProperty('--ry', ((0.5 - py) * 2 * MAXT).toFixed(2) + 'deg');
      foil.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
      foil.style.setProperty('--my', (py * 100).toFixed(1) + '%');
      foil.classList.add('is-tilting');
    });
    foil.addEventListener('pointerleave', function () {
      foil.classList.remove('is-tilting');
      foil.style.setProperty('--rx', '0deg');
      foil.style.setProperty('--ry', '0deg');
    });
  }
  function foilWrap(img) {
    var f = el('div', 'foil');
    f.appendChild(img);
    f.appendChild(el('div', 'foil__sheen'));
    attachFoil(f);
    return f;
  }
  // front = the `big` image; back = the optional `b2` image.
  function openLightbox(front, back, name, opener) {
    if (!front && !back) return;
    var lb = ensureLightbox();
    var inner = lb.querySelector('.card-lightbox__inner');
    inner.textContent = '';
    if (front) inner.appendChild(foilWrap(lightboxImg(front, name ? name + ' (front)' : '')));
    if (back) {
      inner.appendChild(foilWrap(lightboxImg(back, name ? name + ' (back)' : '')));
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
    // NOTE: no role=row here. The accordion body is a gallery (a CSS grid of
    // tiles), not a data table, so ARIA grid roles (row/rowgroup/cell) without
    // a table/grid ancestor are invalid and were removed (a11y audit).

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
    if (name) nameCell.setAttribute('title', name);   // hover tooltip for the now 1-line-ellipsized name
    meta.appendChild(nameCell);

    // Sub line: SET · #cn · Rarity (mirrors the decks meta line).
    var sub = el('div', 'card-tile__sub');
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
    // foil-only when p is null; an explicit "No price" chip when both are null
    // (a bare "-" read as a typo / missing data) (Item 4). The .card-tile__noprice
    // CSS is owned by another agent; we only emit the element here.
    var price = el('div', 'card-tile__price');
    price.appendChild(el('span', 'lbl', 'TCG'));
    var pStr = fmtPrice(c.p);
    var pfStr = fmtPrice(c.pf);
    // USD prominent; foil is a quieter secondary on its own line.
    if (pStr) {
      price.appendChild(document.createTextNode(pStr));
      if (pfStr) price.appendChild(el('span', 'card-tile__foil', 'foil ' + pfStr));
    } else if (pfStr) {
      price.appendChild(document.createTextNode(pfStr));
      price.appendChild(el('span', 'card-tile__foil', 'foil only'));
    } else {
      price.appendChild(el('span', 'card-tile__noprice', 'No price'));
    }
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

  // Rarity predicate factory keyed by the rarity-chip value. 'all' (or any
  // unknown value) keeps everything; otherwise an exact, case-insensitive
  // match on the card's rarity. Cards with off-ladder rarities ('special',
  // 'bonus') therefore only show under "All", which is correct.
  function rarityPredicateFor(rarityKey) {
    if (!rarityKey || rarityKey === 'all') return null; // null = keep all
    var want = String(rarityKey).toLowerCase();
    return function (c) { return String(c.r || '').toLowerCase() === want; };
  }

  // Build the derived categories for the current scope + sort + rarity.
  //   scope === '' -> all cards; otherwise keep only card.s === scope.
  //   rarityKey 'all'/null -> all rarities; otherwise that rarity only.
  //   Filtering runs over the FULL base arrays; empty categories are dropped.
  //   Each kept category gets a sorted COPY of its cards (the base arrays are
  //   never mutated) and a count reflecting the filtered length.
  function deriveCategories(baseCats, scope, sortKey, rarityKey) {
    var cmp = comparatorFor(sortKey);
    var rarityOk = rarityPredicateFor(rarityKey);
    var out = [];
    for (var i = 0; i < baseCats.length; i++) {
      var cat = baseCats[i];
      var src = cat.cards || [];
      var cards;
      if (scope || rarityOk) {
        // Single filtering pass over the full array (scope and/or rarity).
        cards = [];
        for (var j = 0; j < src.length; j++) {
          var card = src[j];
          if (scope && card.s !== scope) continue;
          if (rarityOk && !rarityOk(card)) continue;
          cards.push(card);
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
  // Live pill registry (parallel to the derived category order) so opening a
  // category can flag the matching jump-pill active. Rebuilt with the toolbar.
  var catPills = [];
  // Monotonic id seed so each category body gets a unique, stable id for the
  // head's aria-controls (Item 9), even across re-renders.
  var _catUid = 0;

  // ============================================================
  //  LIVE REGION (a11y - WCAG 4.1.3)  (Item 4)
  //  A single visually-hidden polite status node. Sighted users see
  //  the breadcrumb/toolbar change; screen-reader users get the same
  //  result-count change announced here on rarity/sort/scope/group
  //  changes. Created once and reused (like the lightbox singleton).
  // ============================================================
  var _live = null;
  function ensureLiveRegion() {
    if (_live) return _live;
    var n = el('div', 'sr-only');
    n.setAttribute('role', 'status');
    n.setAttribute('aria-live', 'polite');
    n.setAttribute('aria-atomic', 'true');
    document.body.appendChild(n);
    _live = n;
    return n;
  }
  // Announce a short summary. Re-setting identical text would not re-fire the
  // announcement, so clear first when the message repeats.
  function announce(msg) {
    var n = ensureLiveRegion();
    if (n.textContent === msg) n.textContent = '';
    n.textContent = msg;
  }
  function unmountLiveRegion() {
    if (_live) { _live.textContent = ''; }
  }

  // ----- Chunked tile render (perf) -----
  // A single open category can hold ~4,500 tiles; mounting them in one task
  // blocks the main thread for seconds (looks hung). Instead we append in
  // CHUNKS across animation frames so the first rows paint immediately and no
  // single task runs long. A render TOKEN invalidates any in-flight render the
  // instant the user collapses or switches category, so stale chunks (and the
  // wrong category's tiles) are never appended. Render-on-expand is preserved:
  // still only the open category's tiles ever touch the DOM.
  // ~60 tiles/frame: a smaller per-frame task than 100 so each chunk's work
  // stays well under a frame budget on slow CPUs, keeping the mount smooth
  // (Item 10). Everything else about the chunked render is unchanged.
  var TILE_CHUNK = 60;
  var _renderToken = 0;
  var _renderRAF = 0;

  // The body whose reserved min-height is live, so any in-flight reservation
  // can be released the instant a render is cancelled (collapse / switch).
  var _reservedBody = null;
  function releaseReservedHeight() {
    if (_reservedBody) {
      _reservedBody.style.minHeight = '';
      _reservedBody = null;
    }
  }

  // ----- Shared grid layout math (CLS reservation + viewport windowing) -----
  // The card-tile footer is pinned to a FIXED height in card-tile.css so every
  // tile is the same total height: image (exact 488x680 aspect) + footer + the
  // tile's gap/padding/border. TILE_META is that fixed add-on (footer + the
  // tile's own gap(8)+pad(8+12)+border(2) = ~30, plus the offset between the
  // body-column width and the narrower image width inside the tile's padding,
  // ~25, nets ~65). It is the ONE meta constant both the height reservation and
  // the windowing measure rows by. The window also MEASURES a real mounted tile
  // and snaps rowH to it, so this analytic value only has to be close enough to
  // guard the first frame's CLS before any tile mounts.
  var TILE_META = 65;
  var GRID_COL_MIN = 220;   // minmax(220px, 1fr)
  var GRID_GAP_FB = 12;     // --space-xs fallback when computed style is absent
  var GRID_PAD_FB = 12;     // --space-xs fallback (body padding)

  // Read the live grid metrics off a body: its content width, the real grid
  // gap + padding (so the math is correct at the mobile breakpoint too, where
  // gap/pad shrink), the column count, the per-column width, and the analytic
  // row height (image + TILE_META). Returns null when the body has no width yet
  // (can't lay out; callers skip with no harm).
  function gridMetrics(body) {
    if (!body) return null;
    var cw = body.clientWidth ||
      (body.parentNode && body.parentNode.clientWidth) || 0;
    if (cw <= 0) return null;
    var gap = GRID_GAP_FB, padX = GRID_PAD_FB, padTop = GRID_PAD_FB, gtc = '';
    if (typeof getComputedStyle === 'function') {
      try {
        var cs = getComputedStyle(body);
        var g = parseFloat(cs.rowGap || cs.gap);
        if (isFinite(g)) gap = g;
        var pl = parseFloat(cs.paddingLeft);
        if (isFinite(pl)) padX = pl;
        var pt = parseFloat(cs.paddingTop);
        if (isFinite(pt)) padTop = pt;
        gtc = cs.gridTemplateColumns || '';
      } catch (e) {}
    }
    // body.clientWidth already excludes its own padding, so the track area is
    // clientWidth minus the two horizontal paddings... clientWidth is the
    // padding box width minus scrollbar, i.e. it INCLUDES padding. Subtract it.
    var inner = cw - padX * 2;
    if (inner <= 0) return null;
    // COLUMN COUNT comes from the grid the browser ACTUALLY laid out, not an
    // analytic guess: getComputedStyle resolves grid-template-columns to the
    // used per-track pixel widths (e.g. "166.5px 166.5px"), so the track count
    // IS the real column count and the first track IS the real column width.
    // This keeps the windowing in lockstep with the CSS at every breakpoint --
    // the responsive phone grid is repeat(2, 1fr) (card-tile.css), which the
    // 220px-minmax math below would misread as 1 column on a ~390px screen,
    // doubling rowH and over-reserving the spacers ~2x (the window then rides
    // above the viewport: blank rows on scroll, a black screen on a big jump).
    // Fall back to the analytic minmax only when no track list is available
    // (collapsed body / no getComputedStyle).
    var cols, colW;
    var tracks = (gtc && gtc !== 'none')
      ? gtc.trim().split(/\s+/).filter(function (t) { return t.charAt(0) !== '['; })
      : null;
    if (tracks && tracks.length) {
      cols = tracks.length;
      colW = parseFloat(tracks[0]);
      if (!isFinite(colW) || colW <= 0) colW = (inner - gap * (cols - 1)) / cols;
    } else {
      cols = Math.floor((inner + gap) / (GRID_COL_MIN + gap));
      if (cols < 1) cols = 1;
      colW = (inner - gap * (cols - 1)) / cols;
    }
    var rowH = (colW * 680 / 488) + TILE_META;   // image (exact aspect) + footer
    return { cw: cw, gap: gap, padX: padX, padTop: padTop,
             cols: cols, colW: colW, rowH: rowH };
  }

  // CLS GUARD (Item 9): reserve a tile grid's FINAL height before its tiles
  // mount, so the body occupies its full size from its first painted frame and
  // the chunked appends fill into already-reserved space instead of growing the
  // body chunk-by-chunk (which would re-shift every collapsed sibling header
  // below it on each frame). Derived from the shared grid metrics; an imperfect
  // estimate only matters during the brief load and is cleared when the real
  // content lands (or the render is superseded), so final layout is exact.
  // (Used by the SMALL-category / flat-fallback chunked path; the windowed path
  // reserves height via its spacers instead.)
  function reserveBodyHeight(body, total) {
    if (!body || total <= 0) return;
    var m = gridMetrics(body);
    if (!m) return;
    var rows = Math.ceil(total / m.cols);
    var estH = m.padTop * 2 + rows * m.rowH + m.gap * (rows - 1);
    if (isFinite(estH) && estH > 0) {
      body.style.minHeight = Math.round(estH) + 'px';
      _reservedBody = body;
    }
  }

  // Bumping the token cancels whatever chunked render is in flight.
  function cancelChunkedRender() {
    _renderToken++;
    releaseReservedHeight();             // drop any height reservation too
    if (_renderRAF) {
      if (typeof cancelAnimationFrame === 'function') {
        try { cancelAnimationFrame(_renderRAF); } catch (e) {}
      }
      _renderRAF = 0;
    }
  }

  // Render `cards` into `body` a chunk at a time. `note` (optional) is a
  // "Loading N cards..." element removed when the last chunk lands. `reserve`
  // (optional, default true) pre-reserves the body's final height so the
  // chunked growth does not re-shift sibling headers (Item 9 CLS guard).
  function renderTilesChunked(body, cards, note, reserve) {
    cancelChunkedRender();               // invalidate any prior in-flight render
    var token = _renderToken;
    var total = cards.length;
    // Small categories: render synchronously, no loading note, no frame wait.
    if (total <= TILE_CHUNK) {
      var frag0 = document.createDocumentFragment();
      for (var k = 0; k < total; k++) frag0.appendChild(buildCardTile(cards[k]));
      body.appendChild(frag0);
      return;
    }
    // Reserve the full height up front (before chunk 1 paints) so siblings
    // settle once. Default on; callers can pass reserve === false to skip.
    if (reserve !== false) reserveBodyHeight(body, total);
    var i = 0;
    var step = function () {
      _renderRAF = 0;
      // Abort if a newer render (or a collapse) superseded this one.
      if (token !== _renderToken) return;
      var end = Math.min(i + TILE_CHUNK, total);
      var frag = document.createDocumentFragment();
      for (; i < end; i++) frag.appendChild(buildCardTile(cards[i]));
      body.appendChild(frag);
      if (i < total) {
        if (note) note.textContent = 'Loading ' + fmtInt(total - i) + ' cards...';
        if (typeof requestAnimationFrame === 'function') {
          _renderRAF = requestAnimationFrame(step);
        } else {
          _renderRAF = 0;
          setTimeout(step, 16);
        }
      } else {
        // Done: the real tiles now define the height; drop the reservation so
        // the final layout is exact (no leftover min-height).
        if (_reservedBody === body) releaseReservedHeight();
        if (note && note.parentNode) {
          note.parentNode.removeChild(note);  // clear the loading note
        }
      }
    };
    step();                              // first chunk paints in this frame
  }

  // ============================================================
  //  VIEWPORT WINDOWING (virtualization)
  //  ------------------------------------------------------------
  //  A large category (or the flat grid) mounts ONLY the on-screen
  //  rows of tiles (+ an overscan), never the whole list, so the DOM
  //  holds a small bounded set even for a 13k-card scope and the mount
  //  is instant. The page itself is the scroll container (the bodies
  //  stay in normal flow); a TOP and a BOTTOM spacer reserve the
  //  off-window scroll height so the page scrollbar is correct and
  //  every section header keeps its stable document position.
  //
  //  Row model (matches card-tile.css's fixed-height tiles + the grid
  //  gap). With STEP = rowH + gap, row r's top offset inside the grid
  //  content is r*STEP. Windowing rows [first..last] inclusive:
  //    topSpacer    = first*STEP - gap        (omitted when first == 0)
  //    bottomSpacer = (totalRows-1-last)*STEP - gap  (omitted at the end)
  //  so [topSpacer][gap][window rows][gap][bottomSpacer] sums EXACTLY to
  //  the full list's content height (verified algebraically), which is
  //  why the scrollbar + header offsets are correct and CLS is ~0.
  //
  //  Only ONE controller is ever active (the open category OR the flat
  //  grid); setup tears the previous one down so its window scroll +
  //  resize listeners never leak.
  // ============================================================
  var VIRTUAL_THRESHOLD = 120; // mount-all under this; window at/above it
  var VIRTUAL_OVERSCAN = 8;    // rows rendered beyond the viewport, each side
  var _activeVC = null;        // the single live virtual controller, or null

  // Tear down the active controller: drop its window scroll + resize listeners
  // (do NOT leak them) and forget it. The body's children are left as-is; the
  // caller (collapse / re-render) clears or replaces the body.
  function teardownVirtual() {
    var vc = _activeVC;
    _activeVC = null;
    if (!vc) return;
    vc.destroyed = true;
    if (vc.onScroll) {
      try { window.removeEventListener('scroll', vc.onScroll); } catch (e) {}
    }
    if (vc.onResize) {
      try { window.removeEventListener('resize', vc.onResize); } catch (e) {}
    }
    if (vc.rafId && typeof cancelAnimationFrame === 'function') {
      try { cancelAnimationFrame(vc.rafId); } catch (e) {}
    }
    vc.rafId = 0;
    // Drop the pinned full-height so a reused/cleared body does not keep a stale
    // min-height (the caller clears the body's children separately).
    if (vc.body) { try { vc.body.style.minHeight = ''; } catch (e) {} }
  }

  function makeSpacer(h) {
    var s = el('div', 'deck-cat__spacer');
    s.setAttribute('aria-hidden', 'true');
    s.style.height = Math.max(0, Math.round(h)) + 'px';
    return s;
  }

  // (Re)derive cols/colW/rowH for the controller from the live body width.
  // Returns true when the column count or row height changed (a relayout that
  // needs a forced window rebuild). rowH starts analytic and is later snapped
  // to a measured tile (vcMeasure).
  function vcComputeLayout(vc) {
    var m = gridMetrics(vc.body);
    if (!m) return false;
    var changed = (m.cols !== vc.cols) ||
      (Math.abs(m.rowH - vc.rowHBase) > 0.5) ||
      (Math.abs(m.gap - vc.gap) > 0.5) ||
      (Math.abs(m.padTop - vc.padTop) > 0.5);
    vc.cols = m.cols;
    vc.colW = m.colW;
    vc.gap = m.gap;
    vc.padTop = m.padTop;
    vc.rowHBase = m.rowH;               // analytic row height (pre-measurement)
    // Keep a measured rowH if we have one and the width is unchanged; otherwise
    // fall back to the analytic value until the next measure.
    if (!vc.measured || changed) vc.rowH = m.rowH;
    vc.totalRows = Math.ceil(vc.cards.length / vc.cols);
    return changed;
  }

  // Compute the visible row range for the current scroll position, with the
  // overscan applied and clamped to [0, totalRows-1].
  function vcVisibleRange(vc) {
    var rect = vc.body.getBoundingClientRect();
    var scrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    var step = vc.rowH + vc.gap;
    // Document-relative top of the grid CONTENT (body border-box top + its
    // top padding).
    var contentTop = rect.top + scrollY + vc.padTop;
    var firstVisible = Math.floor((scrollY - contentTop) / step);
    var lastVisible = Math.floor((scrollY + vh - contentTop) / step);
    var first = firstVisible - VIRTUAL_OVERSCAN;
    var last = lastVisible + VIRTUAL_OVERSCAN;
    if (first < 0) first = 0;
    if (last > vc.totalRows - 1) last = vc.totalRows - 1;
    if (last < 0) last = 0;
    if (first > last) first = last;
    return { first: first, last: last };
  }

  // Build [topSpacer?, window tiles, bottomSpacer?] for rows [first..last] and
  // swap them into the body in one shot. force=true rebuilds even if the row
  // range is unchanged (used after a relayout / measurement).
  function vcRenderWindow(vc, range, force) {
    if (vc.destroyed) return;
    if (!force && range.first === vc.firstRow && range.last === vc.lastRow &&
        vc.rendered) {
      return;
    }
    vc.firstRow = range.first;
    vc.lastRow = range.last;
    vc.rendered = true;

    var cols = vc.cols;
    var n = vc.cards.length;
    var step = vc.rowH + vc.gap;
    var startCard = range.first * cols;
    var endCard = Math.min(n, (range.last + 1) * cols);

    var nodes = [];
    // TOP spacer: reserves rows [0..first). Omitted at the very top.
    if (range.first > 0) {
      nodes.push(makeSpacer(range.first * step - vc.gap));
    }
    for (var ci = startCard; ci < endCard; ci++) {
      nodes.push(buildCardTile(vc.cards[ci]));
    }
    // BOTTOM spacer: reserves rows (last..totalRows-1]. Omitted at the end.
    var bottomRows = vc.totalRows - 1 - range.last;
    if (bottomRows > 0) {
      nodes.push(makeSpacer(bottomRows * step - vc.gap));
    }
    // ATOMIC swap: replaceChildren removes the old window + mounts the new one
    // in a SINGLE DOM mutation, so layout never observes an empty (zero-height)
    // body mid-swap. Combined with the pinned min-height + overflow-anchor:none,
    // this keeps the document height stable so scroll-to-bottom actually reaches
    // the last row (no scroll-anchoring fight, no clamp short of the end).
    if (typeof vc.body.replaceChildren === 'function') {
      vc.body.replaceChildren.apply(vc.body, nodes);
    } else {
      vc.body.textContent = '';
      for (var ni = 0; ni < nodes.length; ni++) vc.body.appendChild(nodes[ni]);
    }
    vc.windowStartCard = startCard;
  }

  // Pin the body to the full list's content height so it never collapses during
  // a window swap (which would shrink the document and clamp the scroll short of
  // the bottom). The spacers already reserve this height when present; the pin
  // guarantees it even for the instant between renders and before the first one.
  function vcPinHeight(vc) {
    var full = vc.padTop * 2 + vc.totalRows * vc.rowH +
      (vc.totalRows - 1) * vc.gap;
    if (isFinite(full) && full > 0) {
      vc.body.style.minHeight = Math.round(full) + 'px';
    }
  }

  // Measure a real mounted tile and snap rowH to it (kills any drift between
  // the analytic estimate and the true rendered height). Returns true when the
  // measured height differed enough to warrant a re-render.
  function vcMeasure(vc) {
    if (vc.destroyed) return false;
    var tile = vc.body.querySelector('.card-tile');
    if (!tile) return false;
    var h = tile.getBoundingClientRect().height;
    if (!isFinite(h) || h <= 0) return false;
    if (Math.abs(h - vc.rowH) > 0.5) {
      vc.rowH = h;
      vc.measured = true;
      return true;
    }
    vc.measured = true;
    return false;
  }

  // Recompute the window for the current scroll/size and render it if the row
  // range changed (or forced). rAF-throttled via the scroll/resize handlers.
  function vcUpdate(vc, force) {
    if (vc.destroyed) return;
    var range = vcVisibleRange(vc);
    vcRenderWindow(vc, range, force);
  }

  // Stand up a windowed controller on `body` for `cards`. Mounts the first
  // window synchronously (instant, no loading note), measures a real tile to
  // lock rowH, then attaches rAF-throttled scroll + resize listeners. Enforces
  // the single-active-controller invariant by tearing down any prior one.
  function setupVirtual(body, cards) {
    teardownVirtual();
    cancelChunkedRender();               // no chunked render competes with us
    releaseReservedHeight();             // spacers reserve height; drop minHeight

    var vc = {
      body: body, cards: cards,
      cols: 0, colW: 0, gap: GRID_GAP_FB, padTop: GRID_PAD_FB,
      rowH: 0, rowHBase: 0, totalRows: 0,
      firstRow: -1, lastRow: -1, windowStartCard: 0,
      rendered: false, measured: false, destroyed: false,
      rafId: 0, rafPending: false,
      onScroll: null, onResize: null
    };
    _activeVC = vc;

    body.textContent = '';
    vcComputeLayout(vc);
    vcPinHeight(vc);                      // pin full height up front (CLS guard)
    // First window (analytic rowH).
    vcUpdate(vc, true);
    // Snap to the real tile height, then re-pin + re-render if it moved.
    if (vcMeasure(vc)) { vcPinHeight(vc); vcUpdate(vc, true); }

    var schedule = function () {
      if (vc.destroyed || vc.rafPending) return;
      vc.rafPending = true;
      if (typeof requestAnimationFrame === 'function') {
        vc.rafId = requestAnimationFrame(function () {
          vc.rafPending = false; vc.rafId = 0;
          if (vc.destroyed) return;
          vcUpdate(vc, false);
        });
      } else {
        setTimeout(function () {
          vc.rafPending = false;
          if (vc.destroyed) return;
          vcUpdate(vc, false);
        }, 16);
      }
    };
    vc.onScroll = schedule;
    vc.onResize = function () {
      if (vc.destroyed) return;
      // A resize can change the column count / column width (and thus rowH);
      // recompute the layout, re-pin the full height, re-snap to a measured
      // tile, and force a rebuild.
      vcComputeLayout(vc);
      vcPinHeight(vc);
      vcUpdate(vc, true);
      if (vcMeasure(vc)) { vcPinHeight(vc); vcUpdate(vc, true); }
    };
    window.addEventListener('scroll', vc.onScroll, { passive: true });
    window.addEventListener('resize', vc.onResize);
    return vc;
  }

  function collapse(idx) {
    if (idx < 0 || idx >= catWraps.length) return;
    // Stop any chunked render targeting this (or any) category before we clear,
    // so an in-flight frame can't repopulate the body we just emptied.
    cancelChunkedRender();
    // Tear down the windowed controller if this body owns it: drop its scroll +
    // resize listeners (never leak them) before the body is cleared.
    if (_activeVC && _activeVC.body === catBodies[idx]) teardownVirtual();
    catWraps[idx].classList.add('is-collapsed');
    catHeads[idx].setAttribute('aria-expanded', 'false');
    // Clear the tiles so the DOM never holds more than the single open category.
    catBodies[idx].innerHTML = '';
  }

  function expand(idx) {
    if (idx < 0 || idx >= catWraps.length) return;
    var body = catBodies[idx];
    // Any prior windowed controller is for a different (now-closing) body; tear
    // it down first so only ONE controller is ever active at a time.
    teardownVirtual();
    body.innerHTML = '';
    catWraps[idx].classList.remove('is-collapsed');
    catHeads[idx].setAttribute('aria-expanded', 'true');
    var cards = catCards[idx] || [];
    // LARGE category: stand up the viewport-windowing controller. It mounts the
    // on-screen window instantly (spacers reserve the rest of the height), so no
    // loading note is needed and the DOM only ever holds window+overscan tiles.
    if (cards.length > VIRTUAL_THRESHOLD) {
      setupVirtual(body, cards);
      syncActivePills();
      return;
    }
    // SMALL category: render every tile normally (full a11y, simplest path).
    // A loading note for the (rare) >chunk-but-<threshold mid case; renderTiles
    // Chunked clears it when done and skips it for the synchronous small render.
    // Item 2: this note is NON-live and aria-hidden. Its text is rewritten on
    // every animation frame as a decrementing countdown, so a role=status /
    // aria-live region here floods AT with ~14 polite announcements per open,
    // burying the real "Jumped to <type>, N cards." summary that the singleton
    // _live / announceState region already owns. Sighted users keep the note.
    var note = el('p', 'deck-cat__loading');
    note.setAttribute('aria-hidden', 'true');
    if (cards.length > TILE_CHUNK) {
      note.textContent = 'Loading ' + fmtInt(cards.length) + ' cards...';
      body.appendChild(note);
    }
    renderTilesChunked(body, cards, note);
    syncActivePills();
  }

  // Find the index of the currently open category, or -1.
  function openIndex() {
    if (openName == null) return -1;
    for (var i = 0; i < catNames.length; i++) {
      if (catNames[i] === openName) return i;
    }
    return -1;
  }

  // Reflect the open category on the jump-pills: the matching pill gets the
  // .is-active treatment + aria-current="true"; every other pill is cleared.
  // Called whenever a category opens, the scope/sort changes, or the rarity
  // filter re-renders the toolbar (Item 4).
  function syncActivePills() {
    var cur = openIndex();
    for (var i = 0; i < catPills.length; i++) {
      var pill = catPills[i];
      if (!pill) continue;
      if (i === cur) {
        pill.classList.add('is-active');
        pill.setAttribute('aria-current', 'true');
      } else {
        pill.classList.remove('is-active');
        pill.removeAttribute('aria-current');
      }
    }
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
      syncActivePills();               // nothing open: clear the active pill
      return;
    }
    // Auto-collapse whatever is open, then open the requested one. Set openName
    // BEFORE expand() so the pill sync inside expand() reads the new open index.
    if (cur !== -1) collapse(cur);
    openName = catNames[idx];
    expand(idx);
    if (scroll) scrollToCat(idx);
  }

  // Open category idx (used by the jump-pills); never toggles shut, and
  // always scrolls its header to the top.
  function openCat(idx) {
    var cur = openIndex();
    if (cur === idx) { scrollToCat(idx); return; }
    if (cur !== -1) collapse(cur);
    openName = catNames[idx];          // set before expand() for the pill sync
    expand(idx);
    scrollToCat(idx);
  }

  function buildCatBlock(category, idx) {
    var wrap = el('div', 'deck-cat is-collapsed');
    wrap.setAttribute('data-cat', category.name);

    var bodyId = 'deck-cat-body-' + (++_catUid);

    var head = el('button', 'deck-cat__head');
    head.setAttribute('type', 'button');
    head.setAttribute('aria-expanded', 'false');
    // Tie the disclosure button to the panel it controls (Item 9).
    head.setAttribute('aria-controls', bodyId);
    head.appendChild(el('span', 'deck-cat__title', '// ' + category.name));
    var count = (category.count != null) ? category.count : (category.cards ? category.cards.length : 0);
    head.appendChild(el('span', 'deck-cat__count', fmtInt(count) + (count === 1 ? ' card' : ' cards')));
    // Item 5 (WCAG 4.1.2): the chevron is decorative; aria-hidden drops the
    // glyph from the head's accessible name (which otherwise read
    // "... N CARDS ▾"). aria-expanded on the head already conveys open/closed.
    var chev = el('span', 'deck-cat__chev', '▾');
    chev.setAttribute('aria-hidden', 'true');
    head.appendChild(chev);
    head.addEventListener('click', function () { toggle(idx, true); });
    // Wrap the disclosure button in a heading so the accordion exposes a
    // document outline / is reachable by heading navigation (Item 9). The
    // heading carries no visual style of its own; the head keeps its look.
    var heading = el('h3', 'deck-cat__heading');
    heading.appendChild(head);
    wrap.appendChild(heading);

    // Gallery of card tiles. NOTE: no role=rowgroup - this is a CSS grid of
    // tiles, not a table, so the ARIA grid role was removed (Item 10).
    var body = el('div', 'deck-cat__body');
    body.id = bodyId;
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
  // its tiles are rendered). On a fresh scope (or if the open category
  // filtered out) the FIRST category is auto-opened so cards show right
  // away rather than landing on an all-collapsed (blank) accordion (Item 3).
  function renderAccordion(gridEl, derivedCats) {
    // Any prior chunked render is for the old block set; stop it before the
    // parallel arrays are reset so a late frame can't write into a dead body.
    cancelChunkedRender();
    // Tear down any active windowed controller too: gridEl.innerHTML below
    // detaches the old body it was driving, so its scroll/resize listeners must
    // be removed first (no leaks, no writes into a detached node). The newly
    // opened body re-virtualizes via expand().
    teardownVirtual();
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
      syncActivePills();
      var note = el('p', 'year-controls__empty',
        'No cards in this set for the current view.');
      gridEl.appendChild(note);
      return;
    }

    for (var k = 0; k < derivedCats.length; k++) {
      gridEl.appendChild(buildCatBlock(derivedCats[k], k));
    }

    // Re-open the same category by name if it survived the re-derive
    // (keeps the open section stable across sort / rarity changes).
    var reopen = openIndex();
    if (reopen === -1) {
      // Fresh scope, or the open category filtered out: auto-open the first
      // (which is first in CATEGORY_ORDER, the order the data already arrives
      // in and deriveCategories preserves). Expand only - NO scroll - so the
      // page stays at the top showing the hero + toolbar + the first section.
      openName = catNames[0];
      reopen = 0;
    }
    expand(reopen); // renders only this one category's tiles (chunked)
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

  // --- Rarity filter chips (scope toolbar). 'all' is the default; the others
  //     match a single card rarity. Off-ladder rarities only appear under All.
  var RARITY_OPTIONS = [
    { value: 'all', label: 'All' },
    { value: 'common', label: 'Common' },
    { value: 'uncommon', label: 'Uncommon' },
    { value: 'rare', label: 'Rare' },
    { value: 'mythic', label: 'Mythic' }
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
  function buildHero(year, totalCards, numCats, totalValue, heroArt) {
    var hero = el('section', 'hero is-readout');
    hero.setAttribute('aria-label', 'Year overview');

    var art = el('div', 'hero__art');
    art.setAttribute('aria-hidden', 'true');
    // Finally feed the hero art: the year bleeds its top card behind the headline.
    if (heroArt) { art.style.backgroundImage = "url('" + String(heroArt).replace(/["'\\]/g, '') + "')"; }
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
    tagline.appendChild(document.createTextNode('Every Magic card printed in ' + year + '. Pick a set below, or All cards for the whole year. '));
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

  // --- Scope readout (compact breadcrumb; the SCOPE view's hero) ---
  // Replaces the big YEAR hero in a scope so the readout reflects the SCOPE,
  // not the year (Item 2). Reads like "2024 > Foundations · 730 cards" (or
  // "2024 > All cards · ..."). The count + value come from the DERIVED cats so
  // they track the live scope AND any active rarity filter. No em dashes.
  function buildScopeReadout(ctx, state, derived) {
    // Live totals across the derived (already scope+rarity filtered) cats so
    // the breadcrumb tracks the active rarity filter (Item 3). Flat mode is now
    // UNCAPPED + virtualized (the whole sorted scope renders), so its count +
    // value sum the FULL set, exactly like type mode - just flattened. The old
    // "Top 200 of N" capping is gone; the breadcrumb advertises the true N.
    var count = 0, value = 0;
    if (state.group === 'flat') {
      // Flat: total the count + value over EVERY scope+rarity-filtered card
      // (the full set the virtualized grid renders), by the current sort order
      // (order does not affect the totals). No slice.
      for (var fi = 0; fi < derived.length; fi++) {
        var fcards = derived[fi].cards || [];
        count += derived[fi].count != null ? derived[fi].count : fcards.length;
        for (var fj = 0; fj < fcards.length; fj++) {
          var fv = parseFloat(fcards[fj].p);
          if (isFinite(fv)) value += fv;
        }
      }
    } else {
      for (var i = 0; i < derived.length; i++) {
        var cards = derived[i].cards || [];
        count += derived[i].count != null ? derived[i].count : cards.length;
        for (var j = 0; j < cards.length; j++) {
          var v = parseFloat(cards[j].p);
          if (isFinite(v)) value += v;
        }
      }
    }
    var scopeName = state.scope
      ? (ctx.setName(state.scope) || state.scope.toUpperCase())
      : 'All cards';

    var bc = el('nav', 'year-scopebar');
    bc.setAttribute('aria-label', 'Scope');

    var crumb = el('div', 'year-scopebar__crumb');
    // Year segment links back to the picker (same target as the Sets button).
    var yearLink = el('a', 'year-scopebar__year');
    yearLink.setAttribute('href', '#');
    yearLink.textContent = ctx.year;
    yearLink.setAttribute('aria-label', 'Back to ' + ctx.year + ' set cards');
    yearLink.addEventListener('click', function (ev) {
      ev.preventDefault();
      clearHash();
    });
    crumb.appendChild(yearLink);
    var sepEl = el('span', 'year-scopebar__sep', '>');
    sepEl.setAttribute('aria-hidden', 'true');
    crumb.appendChild(sepEl);
    var nameEl = el('span', 'year-scopebar__name', scopeName);
    nameEl.setAttribute('title', scopeName);
    crumb.appendChild(nameEl);
    bc.appendChild(crumb);

    var stats = el('div', 'year-scopebar__stats');
    var cntEl = el('span', 'year-scopebar__count');
    cntEl.appendChild(el('strong', null, fmtInt(count)));
    cntEl.appendChild(document.createTextNode(count === 1 ? ' card' : ' cards'));
    if (state.group === 'flat') {
      // Flat is uncapped now; append the ranking so "N cards · by price" reads
      // as the full, sorted list (no cap to disclose). No em dashes (middle dot).
      cntEl.appendChild(el('span', 'year-scopebar__sep-dot', ' · '));
      cntEl.appendChild(document.createTextNode('by ' + sortPhrase(state.sort)));
    }
    stats.appendChild(cntEl);
    if (value > 0) {
      stats.appendChild(el('span', 'year-scopebar__sep-dot', '·'));
      var valEl = el('span', 'year-scopebar__value', fmtMoney(value));
      valEl.setAttribute('title', 'Total nonfoil market value');
      stats.appendChild(valEl);
    }
    bc.appendChild(stats);

    return bc;
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
  // Map a sort key to a short phrase for labels / the live region.
  var SORT_PHRASE = {
    name: 'name', price: 'price', rarity: 'rarity', cmc: 'mana value'
  };
  function sortPhrase(key) { return SORT_PHRASE[key] || 'name'; }

  // The two grouping modes (Item 2). 'type' = the type accordion (default);
  // 'flat' = one price-ranked list of the scope's cards (top 200).
  var GROUP_OPTIONS = [
    { value: 'type', label: 'By type' },
    { value: 'flat', label: 'Flat' }
  ];
  var FLAT_CAP = 200;

  // onChange() is fired whenever the sort, rarity filter, OR grouping mode
  // changes; the caller (renderScope.apply) re-derives + repaints. The pill
  // registry (catPills) is rebuilt here so syncActivePills can flag the open
  // type (it is left empty in flat mode, where the pills are hidden).
  function buildToolbar(ctx, state, derived, onChange) {
    var bar = el('div', 'year-toolbar');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Scope controls');
    var isFlat = state.group === 'flat';

    // Row 1: back button + scope label + group toggle + sort.
    var topRow = el('div', 'year-toolbar__row');

    var back = el('button', 'year-toolbar__back');
    back.setAttribute('type', 'button');
    back.appendChild(el('span', 'year-toolbar__back-arrow', '←'));
    back.appendChild(document.createTextNode(' Sets'));
    back.setAttribute('aria-label', 'Back to set cards');
    back.addEventListener('click', function () { clearHash(); });
    topRow.appendChild(back);

    // Scope label: just the scope NAME (the breadcrumb already carries the
    // count, so duplicating it here only truncated on mobile) (Item 5).
    var label = el('div', 'year-toolbar__label');
    label.textContent = state.scope
      ? (ctx.setName(state.scope) || state.scope.toUpperCase())
      : 'All cards';
    label.setAttribute('title', label.textContent);
    topRow.appendChild(label);

    // Group toggle: "By type | Flat" (Item 2). A 2-button segmented control;
    // the active mode carries aria-pressed="true" + .is-active. CSP-safe.
    var groupField = el('div', 'year-toolbar__group');
    groupField.setAttribute('role', 'group');
    groupField.setAttribute('aria-label', 'Group cards');
    groupField.appendChild(el('span', 'year-toolbar__group-lbl', 'Group'));
    var groupBtns = el('div', 'year-group');
    for (var gi = 0; gi < GROUP_OPTIONS.length; gi++) {
      (function (opt) {
        var gb = el('button', 'year-group__btn', opt.label);
        gb.setAttribute('type', 'button');
        gb.setAttribute('data-group', opt.value);
        var on = (state.group || 'type') === opt.value;
        gb.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (on) gb.classList.add('is-active');
        gb.addEventListener('click', function () {
          if ((state.group || 'type') === opt.value) return; // no-op re-click
          state.group = opt.value;
          // Item 1: Flat exists to surface chase cards, so a "Name" sort there
          // yields a useless A-Aj slice (the top 200 alphabetically). Entering
          // Flat while sorted by Name auto-switches Sort to Price (high to low)
          // so the flat list ranks by value. Name stays selectable once in Flat;
          // this only defaults the sort on ENTRY. The flat note + live region
          // both read state.sort, so they stay accurate to the new sort.
          if (opt.value === 'flat' && state.sort === 'name') {
            state.sort = 'price';
          }
          state._refocus = { kind: 'group', value: opt.value };
          onChange();
        });
        groupBtns.appendChild(gb);
      })(GROUP_OPTIONS[gi]);
    }
    groupField.appendChild(groupBtns);
    topRow.appendChild(groupField);

    // Sort select. The visible "Sort" text is the accessible name via the
    // wrapping <label>; no redundant aria-label on the select (Item 6).
    var sortField = el('label', 'year-toolbar__sort');
    sortField.appendChild(el('span', 'year-toolbar__sort-lbl', 'Sort'));
    var sortSel = el('select', 'year-controls__select');
    for (var k = 0; k < SORT_OPTIONS.length; k++) {
      var so = SORT_OPTIONS[k];
      var sopt = el('option', null, so.label);
      sopt.value = so.value;
      sortSel.appendChild(sopt);
    }
    sortSel.value = state.sort;
    sortSel.addEventListener('change', function () {
      state.sort = sortSel.value;
      state._refocus = { kind: 'sort' };
      onChange();
    });
    sortField.appendChild(sortSel);
    topRow.appendChild(sortField);

    bar.appendChild(topRow);

    // Row 2: rarity filter chips (All / Common / Uncommon / Rare / Mythic).
    // Filters the cards within the open scope across every type category by
    // re-deriving on the FULL arrays; the active sort + auto-open are kept
    // by renderAccordion. CSP-safe: wired via addEventListener.
    var rarityRow = el('div', 'year-toolbar__rarity');
    rarityRow.setAttribute('role', 'group');
    rarityRow.setAttribute('aria-label', 'Filter by rarity');
    var curRarity = state.rarity || 'all';
    for (var ri = 0; ri < RARITY_OPTIONS.length; ri++) {
      (function (opt) {
        var chip = el('button', 'year-rarity year-rarity--' + opt.value);
        chip.setAttribute('type', 'button');
        chip.textContent = opt.label;
        // Item 3 (WCAG 2.5.3 Label in Name): no aria-label, so the accessible
        // name IS the visible word ("Rare", "Mythic", "All"). The previous
        // "Show Rare cards" started with "Show", so voice-control users saying
        // "click Rare" could miss it. The group toggle buttons already use their
        // visible label as the name (no aria-label), so they need no change.
        if (curRarity === opt.value) {
          chip.classList.add('is-active');
          chip.setAttribute('aria-pressed', 'true');
        } else {
          chip.setAttribute('aria-pressed', 'false');
        }
        chip.addEventListener('click', function () {
          if (state.rarity === opt.value) return; // no-op re-click
          state.rarity = opt.value;
          // Item 1: re-render dumps focus to <body>; remember which chip the
          // user just hit so apply() can hand focus back to its rebuilt twin.
          state._refocus = { kind: 'rarity', value: opt.value };
          onChange();
        });
        rarityRow.appendChild(chip);
      })(RARITY_OPTIONS[ri]);
    }
    bar.appendChild(rarityRow);

    // Row 3: type jump-pills (one per non-empty type in this scope). Each pill
    // is registered into catPills so syncActivePills can mark the open type.
    // HIDDEN in flat mode: there are no type sections to jump to (Item 2).
    catPills = [];
    if (!isFlat && derived.length) {
      var pills = el('div', 'year-toolbar__pills');
      // Item 4 (WCAG 1.3.1): a bare <div> is role=generic, where aria-label is
      // not guaranteed to be exposed; role=group makes the label reliable
      // (matches the rarity row, which already sets role=group).
      pills.setAttribute('role', 'group');
      pills.setAttribute('aria-label', 'Jump to type');
      for (var i = 0; i < derived.length; i++) {
        (function (idx, cat) {
          var pill = el('button', 'year-pill');
          pill.setAttribute('type', 'button');
          pill.appendChild(el('span', 'year-pill__name', cat.name));
          pill.appendChild(el('span', 'year-pill__n', fmtInt(cat.count)));
          pill.setAttribute('aria-label',
            'Jump to ' + cat.name + ' (' + fmtInt(cat.count) + ' cards)');
          pill.addEventListener('click', function () {
            openCat(idx);
            // Item 2: jump-pill activation is otherwise silent to screen readers
            // (the scroll + open are visual only). Announce the destination via
            // the existing aria-live status node, e.g. "Jumped to Lands, 1,467
            // cards." so AT users hear where focus / the view moved.
            announce('Jumped to ' + cat.name + ', ' + fmtInt(cat.count) +
              (cat.count === 1 ? ' card.' : ' cards.'));
          });
          pills.appendChild(pill);
          catPills[idx] = pill;
        })(i, derived[i]);
      }
      bar.appendChild(pills);
    }

    return bar;
  }

  // After the toolbar is rebuilt, hand keyboard focus back to the control the
  // user just operated (its old node was replaced, dumping focus to <body>).
  // Item 1 (rarity is the WCAG-flagged case); group + sort kept consistent.
  function restoreToolbarFocus(bar, state) {
    var want = state._refocus;
    state._refocus = null;
    if (!want || !bar) return;
    var target = null;
    if (want.kind === 'rarity') {
      target = bar.querySelector('.year-rarity--' + want.value);
    } else if (want.kind === 'group') {
      target = bar.querySelector('.year-group__btn[data-group="' + want.value + '"]');
    } else if (want.kind === 'sort') {
      target = bar.querySelector('.year-controls__select');
    }
    if (target && typeof target.focus === 'function') {
      try { target.focus(); } catch (e) {}
    }
  }

  // Item 4: build + push a concise live-region summary of the current view
  // (count, rarity, sort, and grouping) for screen-reader users.
  function announceState(ctx, state, derived) {
    var count = 0;
    for (var i = 0; i < derived.length; i++) {
      count += derived[i].count != null ? derived[i].count
        : (derived[i].cards ? derived[i].cards.length : 0);
    }
    var rarity = (state.rarity && state.rarity !== 'all') ? (state.rarity + ' ') : '';
    var noun = (count === 1 ? 'card' : 'cards');
    var msg;
    if (state.group === 'flat') {
      // Flat is uncapped + virtualized: announce the FULL N (no "top 200 of N").
      msg = 'Showing all ' + fmtInt(count) + ' ' + rarity + noun +
        ' by ' + sortPhrase(state.sort) + '.';
    } else {
      msg = 'Showing ' + fmtInt(count) + ' ' + rarity + noun +
        ', sorted by ' + sortPhrase(state.sort) + '.';
    }
    announce(msg);
  }

  // ----- FLAT (price-ranked) render (Item 2) -----
  // One grid of the scope's cards (after the rarity filter), sorted by the
  // current Sort. UNCAPPED: the whole sorted scope is shown, virtualized, so
  // the DOM still only ever holds the on-screen window (+ overscan) even for a
  // 13k-card "All cards" flat list. (FLAT_CAP is retained only as a label
  // threshold for the breadcrumb wording elsewhere; it no longer truncates the
  // rendered or counted set.) The accordion bookkeeping is torn down so the
  // single-open invariant + pill sync stay coherent when toggling back to type
  // mode; the single windowed controller is enforced by setupVirtual.
  function renderFlat(gridEl, derivedCats, state) {
    // Any in-flight accordion render is for the old block set; stop it and
    // clear the parallel arrays so a late frame can't write into a dead body.
    cancelChunkedRender();
    teardownVirtual();                   // drop any prior windowed controller
    catHeads = []; catWraps = []; catBodies = []; catCards = []; catNames = [];
    catPills = [];
    openName = null;

    // Concat the already scope+rarity-filtered categories, then sort the WHOLE
    // set by the current comparator. No slice: the full set is rendered.
    var all = [];
    for (var i = 0; i < derivedCats.length; i++) {
      var cards = derivedCats[i].cards || [];
      for (var j = 0; j < cards.length; j++) all.push(cards[j]);
    }
    var total = all.length;
    all.sort(comparatorFor(state.sort));

    gridEl.innerHTML = '';
    if (!total) {
      var empty = el('p', 'year-controls__empty',
        'No cards in this set for the current view.');
      gridEl.appendChild(empty);
      return;
    }

    var wrap = el('div', 'year-flat');
    var note = el('p', 'year-flat__note');
    // Uncapped: the note reflects the FULL N, by the current sort.
    note.textContent = 'Showing all ' + fmtInt(total) +
      (total === 1 ? ' card' : ' cards') + ' by ' + sortPhrase(state.sort) + '.';
    wrap.appendChild(note);

    var body = el('div', 'deck-cat__body year-flat__grid');
    wrap.appendChild(body);
    gridEl.appendChild(wrap);

    // Virtualize when the list is large; for a tiny flat list render all tiles
    // normally (full a11y, no controller). Same threshold as the accordion.
    if (total > VIRTUAL_THRESHOLD) {
      setupVirtual(body, all);
    } else {
      renderTilesChunked(body, all);
    }
  }

  function renderScope(ctx, host, state) {
    host.innerHTML = '';

    // Compact scope breadcrumb stands in for the big YEAR hero here (Item 2).
    // Held in a slot so it can be rebuilt with the toolbar when the rarity
    // filter changes the live count/value.
    var readoutHolder = { node: null };

    var grid = el('div', 'deck-grid');
    grid.id = 'year-grid';

    var toolbarHolder = { bar: null };

    // Re-derive + repaint the accordion, the scope readout, and the toolbar
    // (rarity chips, sort, and the jump-pills, which track the live derived
    // set). Filtering runs on the FULL base arrays; render-on-expand + the
    // auto-open are preserved by renderAccordion.
    function apply() {
      // Remember the chosen sort + rarity + grouping so they carry to the
      // next scope.
      ctx.lastSort = state.sort;
      ctx.lastRarity = state.rarity;
      ctx.lastGroup = state.group;
      var derived = deriveCategories(ctx.baseCats, state.scope, state.sort, state.rarity);

      // Rebuild the scope readout so its count/value reflect the live filter.
      var newReadout = buildScopeReadout(ctx, state, derived);
      if (readoutHolder.node && readoutHolder.node.parentNode) {
        readoutHolder.node.parentNode.replaceChild(newReadout, readoutHolder.node);
      } else {
        host.insertBefore(newReadout, grid);
      }
      readoutHolder.node = newReadout;

      // Rebuild the toolbar so the chips/pills/group toggle reflect the live
      // derived set.
      var newBar = buildToolbar(ctx, state, derived, apply);
      if (toolbarHolder.bar && toolbarHolder.bar.parentNode) {
        toolbarHolder.bar.parentNode.replaceChild(newBar, toolbarHolder.bar);
      } else {
        host.insertBefore(newBar, grid);
      }
      toolbarHolder.bar = newBar;
      watchToolbar(newBar);

      // Route to the chosen grouping. Flat mode renders one price-ranked,
      // capped grid; type mode renders the accordion (render-on-expand +
      // auto-open). Both keep the DOM tile bound (one category / top 200).
      if (state.group === 'flat') {
        renderFlat(grid, derived, state);
      } else {
        renderAccordion(grid, derived);
      }
      // Reflect the (possibly auto-opened) category on the freshly built pills
      // (a no-op in flat mode, where there are no pills).
      syncActivePills();

      // Item 1: hand focus back to the control the user just operated.
      restoreToolbarFocus(newBar, state);

      // Item 4: announce the live result/filter state to assistive tech.
      announceState(ctx, state, derived);
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
      unmountLiveRegion();   // clear any stale scope announcement (Item 4)
      cancelChunkedRender(); // drop any in-flight tile mount + its reservation
      teardownVirtual();     // drop the windowed controller's scroll/resize hooks
      openName = null;
      host.innerHTML = '';
      host.appendChild(ctx.hero);
      host.appendChild(renderPicker(ctx));
      // Reset scroll to the top so the picker starts at the hero.
      try { window.scrollTo(0, 0); } catch (e) {}
    } else {
      // Scope view. Reset the open category whenever the scope changes so the
      // new scope auto-opens its first category (Item 3).
      if (ctx.lastScope !== route.scope) {
        openName = null;
        // Item 7: a rarity filter carried from the previous scope silently
        // shrinks a freshly opened set (e.g. land on "Mythic" with most cards
        // hidden). Reset rarity to "All" on a SCOPE change so each set/All-cards
        // view starts unfiltered; the Sort + Group choice still carry over.
        ctx.lastRarity = 'all';
        ctx.lastScope = route.scope;
      }
      var state = {
        scope: route.scope,
        sort: ctx.lastSort || 'name',
        rarity: ctx.lastRarity || 'all',
        group: ctx.lastGroup || 'type'
      };
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
    var hero = buildHero(year, totalCards, sets.length, totalValue, heroSet ? heroSet.art : '');

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
      lastSort: 'name',
      lastRarity: 'all',
      lastGroup: 'type'
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
