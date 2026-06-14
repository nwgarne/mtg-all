/* mtg-all.dirtyshoulders.com - card-name search across every printing.
 *
 * Loaded on every page (homepage + each year page). Wires the topbar search box:
 * typing gives autocomplete suggestions, and picking a card opens an overlay listing
 * EVERY printing (every set the card appeared in), pulled live from the Scryfall API.
 *
 * CSP notes: this is an external file (script-src 'self'); it fetches api.scryfall.com
 * (connect-src) and shows images from cards.scryfall.io (img-src). No inline handlers.
 * Each printing is mapped onto the site's own .card-tile / .card-lightbox so the results
 * look identical to the rest of the site - but the SET NAME is the primary label, since
 * the whole point is "which sets was this card printed in".
 */
(function () {
  'use strict';

  var API = 'https://api.scryfall.com';

  // ---- tiny helpers (mirror year.js) ----
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
  function fmtPrice(raw) {
    if (raw == null) return null;
    var v = parseFloat(raw);
    if (!isFinite(v)) return null;
    // Group thousands so a chase printing reads "$1,234.56" not "$1234.56".
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms);
    };
  }

  // ---- focus trap (modal dialogs) ----
  // Returns the tabbable elements inside a container, in DOM order. We keep the
  // selector simple because our dialogs only ever hold buttons, links and images.
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), ' +
    'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function focusables(container) {
    var all = container.querySelectorAll(FOCUSABLE);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      // Skip anything hidden (display:none collapses offsetParent to null).
      if (n.offsetParent !== null || n === document.activeElement) out.push(n);
    }
    return out;
  }
  // Keep Tab / Shift+Tab inside the open dialog: wrap last->first and first->last.
  function trapTab(container, ev) {
    if (ev.key !== 'Tab') return;
    var f = focusables(container);
    if (!f.length) { ev.preventDefault(); return; }
    var first = f[0], last = f[f.length - 1];
    var act = document.activeElement;
    if (ev.shiftKey) {
      if (act === first || !container.contains(act)) { ev.preventDefault(); try { last.focus(); } catch (e) {} }
    } else {
      if (act === last || !container.contains(act)) { ev.preventDefault(); try { first.focus(); } catch (e) {} }
    }
  }

  // ---- Scryfall fetch ----
  // Each request is its own fetch; autocomplete is debounced upstream so we stay
  // well within Scryfall's rate guidance. A monotonically increasing token guards
  // against out-of-order responses clobbering a newer query.
  function jget(url) {
    return fetch(url, { headers: { 'Accept': 'application/json' }, credentials: 'omit' })
      .then(function (r) {
        if (r.status === 404) return null;            // no such card / no prints
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
  }
  function autocomplete(term) {
    return jget(API + '/cards/autocomplete?q=' + encodeURIComponent(term))
      .then(function (d) { return (d && d.data) || []; });
  }
  // Every printing of an exact card name, newest set first. Follows pagination
  // (a few cards exceed one page) up to a sane cap.
  function allPrintings(name) {
    var q = '!"' + String(name).replace(/"/g, '') + '"';
    var url = API + '/cards/search?unique=prints&order=released&dir=desc&q=' + encodeURIComponent(q);
    var out = [];
    function page(u, depth) {
      return jget(u).then(function (d) {
        if (!d || !d.data) return out;
        out = out.concat(d.data);
        if (d.has_more && d.next_page && depth < 6) return page(d.next_page, depth + 1);
        return out;
      });
    }
    return page(url, 0);
  }

  // ---- map a Scryfall card object -> our tile record ----
  function toRec(card) {
    var faces = card.card_faces || [];
    var front = card.image_uris || (faces[0] && faces[0].image_uris) || {};
    var back = '';
    if (!card.image_uris && faces.length >= 2 && faces[1] && faces[1].image_uris) {
      back = faces[1].image_uris.normal || '';
    }
    var prices = card.prices || {};
    return {
      n: card.name || '',
      s: card.set || '',
      setName: card.set_name || card.set || '',
      cn: card.collector_number || '',
      year: (card.released_at || '').slice(0, 4),
      released: card.released_at || '',
      r: card.rarity || '',
      p: prices.usd,
      pf: prices.usd_foil,
      img: front.small || front.normal || '',
      big: front.normal || front.large || front.small || '',
      b2: back,
      u: (card.scryfall_uri || '').split('?')[0]
    };
  }

  // ---- live region (WCAG 4.1.3) ----
  // One visually-hidden polite status node, shared by the whole module, so SR users
  // hear "no matches" and the printings count without a visible status line. Toggling
  // textContent between identical strings would not re-announce, so we blank-then-set.
  var _live = null;
  function ensureLive() {
    if (_live) return _live;
    var n = el('div', 'sr-only');
    n.setAttribute('role', 'status');
    n.setAttribute('aria-live', 'polite');
    n.setAttribute('aria-atomic', 'true');
    document.body.appendChild(n);
    _live = n;
    return n;
  }
  function announce(msg) {
    var n = ensureLive();
    n.textContent = '';
    // Re-set on the next frame so assistive tech registers a change even when the
    // new message equals the previous one.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { n.textContent = msg; });
    } else {
      n.textContent = msg;
    }
  }

  // ============================================================
  //  LIGHTBOX (own instance, distinct id; reuses .card-lightbox CSS)
  // ============================================================
  var _lb = null, _lbOpener = null, _lbOpen = false;
  function ensureLightbox() {
    if (_lb) return _lb;
    var lb = el('div', 'card-lightbox');
    lb.id = 'mtg-find-lightbox';
    lb.setAttribute('role', 'dialog');
    lb.setAttribute('aria-modal', 'true');
    lb.setAttribute('aria-hidden', 'true');
    lb.setAttribute('aria-label', 'Card preview');
    var inner = el('div', 'card-lightbox__inner');
    lb.appendChild(inner);
    var close = el('button', 'card-lightbox__close', '×');
    close.setAttribute('type', 'button');
    close.setAttribute('aria-label', 'Close card preview');
    lb.appendChild(close);
    lb.addEventListener('click', function (ev) { if (ev.target === lb) closeLightbox(); });
    close.addEventListener('click', closeLightbox);
    // Trap Tab within the zoom while it is open (it rides above the overlay).
    lb.addEventListener('keydown', function (ev) { if (_lbOpen) trapTab(lb, ev); });
    document.body.appendChild(lb);
    _lb = lb;
    return lb;
  }
  function lbImg(src, alt) {
    var img = document.createElement('img');
    img.setAttribute('src', src);
    img.setAttribute('alt', alt || '');
    return img;
  }
  function openLightbox(front, back, name, opener) {
    if (!front && !back) return;
    var lb = ensureLightbox();
    var inner = lb.querySelector('.card-lightbox__inner');
    inner.textContent = '';
    if (front) inner.appendChild(lbImg(front, name ? name + ' (front)' : ''));
    if (back) { inner.appendChild(lbImg(back, name ? name + ' (back)' : '')); lb.classList.add('is-dfc'); }
    else lb.classList.remove('is-dfc');
    lb.classList.add('is-open');
    lb.setAttribute('aria-hidden', 'false');
    _lbOpen = true;
    _lbOpener = opener || null;
    var c = lb.querySelector('.card-lightbox__close');
    if (c) { try { c.focus(); } catch (e) {} }
  }
  function closeLightbox() {
    if (!_lb) return;
    _lb.classList.remove('is-open');
    _lb.classList.remove('is-dfc');
    _lb.setAttribute('aria-hidden', 'true');
    _lb.querySelector('.card-lightbox__inner').textContent = '';
    _lbOpen = false;
    if (_lbOpener && typeof _lbOpener.focus === 'function') { try { _lbOpener.focus(); } catch (e) {} }
    _lbOpener = null;
  }

  // ============================================================
  //  PRINTING TILE (reuses .card-tile; SET NAME is the headline)
  // ============================================================
  function printingTile(c) {
    // A gallery of tiles, not a table: no role=row/cell (there is no grid/table
    // ancestor, so those roles are orphaned and only confuse assistive tech).
    var row = el('div', 'card-tile');
    row.setAttribute('data-card', c.n);

    var imgWrap = el('button', 'card-tile__image');
    imgWrap.setAttribute('type', 'button');
    var dfc = !!c.b2;
    imgWrap.setAttribute('aria-label', 'Preview ' + c.n + ' from ' + (c.setName || c.s) +
      ' larger' + (dfc ? ' (front and back)' : ''));
    imgWrap.addEventListener('click', function () { openLightbox(c.big, c.b2, c.n, imgWrap); });
    if (c.img) {
      var im = document.createElement('img');
      im.setAttribute('loading', 'lazy');
      im.setAttribute('decoding', 'async');
      im.setAttribute('src', c.img);
      im.setAttribute('alt', c.n + ' (' + (c.setName || c.s) + ')');
      imgWrap.appendChild(im);
    }
    row.appendChild(imgWrap);

    var meta;
    if (c.u) {
      meta = el('a', 'card-tile__meta');
      meta.setAttribute('href', c.u);
      meta.setAttribute('target', '_blank');
      meta.setAttribute('rel', 'noopener noreferrer');
      meta.setAttribute('aria-label', (c.setName || c.s) + ' printing on Scryfall');
    } else {
      meta = el('div', 'card-tile__meta');
    }
    // Headline = the set name (the answer to "which sets"); sub = year, code, number, rarity.
    var nameCell = el('div', 'card-tile__name', c.setName || (c.s ? c.s.toUpperCase() : '-'));
    nameCell.setAttribute('title', c.setName || (c.s ? c.s.toUpperCase() : ''));   // hover tooltip for the 1-line-ellipsized set name
    meta.appendChild(nameCell);
    var sub = el('div', 'card-tile__sub');
    var parts = [];
    if (c.year) parts.push(c.year);
    if (c.s) parts.push(c.s.toUpperCase());
    if (c.cn) parts.push('#' + c.cn);
    if (c.r) parts.push(cap(c.r));
    if (!parts.length) parts.push('-');
    for (var i = 0; i < parts.length; i++) {
      if (i > 0) sub.appendChild(el('span', 'sep', '·'));
      sub.appendChild(el('span', null, parts[i]));
    }
    meta.appendChild(sub);
    row.appendChild(meta);

    var price = el('div', 'card-tile__price');
    price.appendChild(el('span', 'lbl', 'TCG'));
    var pStr = fmtPrice(c.p), pfStr = fmtPrice(c.pf);
    // USD prominent; foil is a quieter secondary on its own line.
    if (pStr) {
      price.appendChild(document.createTextNode(pStr));
      if (pfStr) price.appendChild(el('span', 'card-tile__foil', 'foil ' + pfStr));
    } else if (pfStr) {
      price.appendChild(document.createTextNode(pfStr));
      price.appendChild(el('span', 'card-tile__foil', 'foil only'));
    } else {
      // No nonfoil AND no foil price: show a labeled "No price" instead of a bare "-"
      // so the cell reads as intentional. (.card-tile__noprice styling is owned elsewhere.)
      price.appendChild(el('span', 'card-tile__noprice', 'No price'));
    }
    row.appendChild(price);

    return row;
  }

  // ============================================================
  //  RESULTS OVERLAY
  // ============================================================
  var _overlay = null, _grid = null, _title = null, _count = null, _overlayOpen = false, _overlayOpener = null;
  var _findInput = null;   // the in-overlay "search another card" field
  var _resultsToken = 0;   // guards out-of-order printings responses (rapid in-overlay re-search)
  function ensureOverlay() {
    if (_overlay) return _overlay;
    var ov = el('div', 'mtg-find');
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-hidden', 'true');
    ov.setAttribute('aria-label', 'Card printings');

    var panel = el('div', 'mtg-find__panel');

    var head = el('div', 'mtg-find__head');
    var titleWrap = el('div', 'mtg-find__titlewrap');
    _title = el('h2', 'mtg-find__title', '');
    _count = el('p', 'mtg-find__count', '');
    titleWrap.appendChild(_title);
    titleWrap.appendChild(_count);

    // "Search another card" without leaving the overlay. It carries .mtg-search so it
    // inherits the topbar field + autocomplete-menu styling, and wireCombobox() gives it
    // the same debounced autocomplete, keyboard handling and clear (x). Picking a card
    // reloads THIS overlay in place (reuse:true keeps focus here + the original opener,
    // so closing still returns focus to the topbar). The input lives inside the dialog,
    // so the existing focus trap already includes it.
    var findWrap = el('div', 'mtg-find__search mtg-search');
    _findInput = document.createElement('input');
    _findInput.className = 'mtg-search__input';
    _findInput.setAttribute('type', 'search');
    _findInput.setAttribute('placeholder', 'Search another card');
    _findInput.setAttribute('aria-label', 'Search another card');
    _findInput.setAttribute('autocomplete', 'off');
    _findInput.setAttribute('autocapitalize', 'off');
    _findInput.setAttribute('autocorrect', 'off');
    _findInput.setAttribute('spellcheck', 'false');
    findWrap.appendChild(_findInput);

    var close = el('button', 'mtg-find__close', '×');
    close.setAttribute('type', 'button');
    close.setAttribute('aria-label', 'Close printings');
    close.addEventListener('click', closeResults);
    head.appendChild(titleWrap);
    head.appendChild(findWrap);
    head.appendChild(close);
    panel.appendChild(head);

    // Reuse all the autocomplete machinery; only the pick action differs: reload the
    // open overlay in place rather than opening a fresh one.
    wireCombobox(_findInput, {
      onChoose: function (picked) { openResults(picked, null, { reuse: true }); }
    });

    var body = el('div', 'mtg-find__body');
    _grid = el('div', 'mtg-find__grid');
    body.appendChild(_grid);
    panel.appendChild(body);

    ov.appendChild(panel);
    ov.addEventListener('click', function (ev) { if (ev.target === ov) closeResults(); });
    // Trap Tab within the results overlay while it is open. When the zoom is up it
    // has its own trap (and focus lives there), so stand down to avoid fighting it.
    ov.addEventListener('keydown', function (ev) { if (_overlayOpen && !_lbOpen) trapTab(ov, ev); });
    document.body.appendChild(ov);
    _overlay = ov;
    return ov;
  }
  // opts.reuse === true means the overlay is ALREADY open and we are reloading it from the
  // in-overlay "search another card" field: keep the original opener (so closing still
  // returns focus to the topbar) and leave focus in the in-overlay input instead of
  // snapping it to the close button.
  function openResults(name, opener, opts) {
    opts = opts || {};
    var reuse = !!opts.reuse && _overlayOpen;
    var my = ++_resultsToken;   // newest query wins; older in-flight responses are dropped
    var ov = ensureOverlay();
    if (!reuse) _overlayOpener = opener || null;
    _title.textContent = name;
    _count.textContent = 'Loading printings…';
    _grid.textContent = '';
    ov.classList.add('is-open');
    ov.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('mtg-find-lock');
    _overlayOpen = true;
    if (!reuse) {
      // Fresh open from the topbar: clear any stale text/menu left in the in-overlay
      // field so it does not contradict the card now shown, then focus the close button.
      if (_findInput && typeof _findInput._mtgReset === 'function') _findInput._mtgReset();
      var close = ov.querySelector('.mtg-find__close');
      if (close) { try { close.focus(); } catch (e) {} }
    }

    allPrintings(name).then(function (cards) {
      if (!_overlayOpen || my !== _resultsToken) return;   // overlay closed or superseded
      // Scryfall's exact-name match also returns double-faced cards whose BACK face
      // carries this name (e.g. "Emeritus of Conflict // Lightning Bolt" for a
      // "Lightning Bolt" search), which would render a differently-named front face
      // and inflate the count. Keep only cards that ARE this card - matched by full
      // name or front-face name (so transform cards searched by their front, and
      // DFCs searched by their full "A // B" name, are still kept).
      if (cards && cards.length) {
        var only = cards.filter(function (card) {
          if (card.name === name) return true;
          var f = card.card_faces;
          return !!(f && f.length && f[0].name === name);
        });
        if (only.length) cards = only;
      }
      if (!cards || !cards.length) { _count.textContent = 'No printings found.'; return; }
      var recs = cards.map(toRec);
      var sets = {};
      for (var i = 0; i < recs.length; i++) { if (recs[i].s) sets[recs[i].s] = 1; }
      var nSets = Object.keys(sets).length;
      var nPr = recs.length;
      // Always show BOTH counts so the pattern is uniform ("Printed in N sets · M
      // printings"), even when N == M; otherwise the "· N printings" clause only
      // surfacing sometimes reads like a missing field.
      var label = 'Printed in ' + nSets + ' set' + (nSets === 1 ? '' : 's') +
        ' · ' + nPr + ' printing' + (nPr === 1 ? '' : 's');
      _count.textContent = label;
      // Announce the loaded result to SR users (always spell out both counts).
      announce(name + ': printed in ' + nSets + ' set' + (nSets === 1 ? '' : 's') +
        ', ' + nPr + ' printing' + (nPr === 1 ? '' : 's') + '.');
      var frag = document.createDocumentFragment();
      for (var j = 0; j < recs.length; j++) frag.appendChild(printingTile(recs[j]));
      _grid.textContent = '';
      _grid.appendChild(frag);
    }).catch(function () {
      if (!_overlayOpen || my !== _resultsToken) return;
      _count.textContent = 'Search is unavailable right now. Try again in a moment.';
    });
  }
  function closeResults() {
    if (_lbOpen) { closeLightbox(); return; }   // first Escape/click closes the zoom, not the list
    if (!_overlay) return;
    _overlay.classList.remove('is-open');
    _overlay.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('mtg-find-lock');
    _grid.textContent = '';
    _overlayOpen = false;
    if (_overlayOpener && typeof _overlayOpener.focus === 'function') { try { _overlayOpener.focus(); } catch (e) {} }
    _overlayOpener = null;
  }

  // ============================================================
  //  AUTOCOMPLETE MENU
  // ============================================================
  // wireCombobox adds the WAI-ARIA combobox + autocomplete menu behavior to an input.
  // Both the topbar search and the in-overlay "search another card" field use it, so the
  // debounced menu, keyboard handling, clear (x) and ARIA are defined once. The only
  // difference is what happens when a card is picked: opts.onChoose(name) (defaults to
  // opening the results overlay for that card).
  function wireCombobox(input, opts) {
    opts = opts || {};
    // Unique id base so the listbox + its options can be referenced by ARIA
    // (aria-controls / aria-activedescendant) even if more than one search ever
    // mounts on a page.
    var uid = 'mtg-search-' + (++wireCombobox._seq);
    var menuId = uid + '-menu';

    var menu = el('div', 'mtg-search__menu');
    menu.id = menuId;
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-hidden', 'true');
    input.parentNode.appendChild(menu);

    // WAI-ARIA APG: combobox-with-listbox. The input owns the popup; options stay
    // out of the tab order and are tracked via aria-activedescendant (set below).
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-controls', menuId);
    input.setAttribute('aria-expanded', 'false');

    var names = [];      // current suggestions
    var active = -1;     // highlighted index
    var token = 0;       // guards out-of-order autocomplete responses

    // Clear (x) button: wipe the field between searches without backspacing.
    var clearBtn = el('button', 'mtg-search__clear', '×');
    clearBtn.setAttribute('type', 'button');
    clearBtn.setAttribute('aria-label', 'Clear search');
    input.parentNode.appendChild(clearBtn);
    function updateClear() {
      if (input.value.length) clearBtn.classList.add('is-visible');
      else clearBtn.classList.remove('is-visible');
    }
    // The clear action runs on CLICK, which fires for mouse, touch, AND keyboard
    // (Enter/Space on a focused button). Wiring it to mousedown alone (the old bug)
    // left it keyboard-inoperable, since Enter/Space never emit mousedown (WCAG 2.1.1).
    function doClear() {
      input.value = '';
      token++;                 // drop any in-flight autocomplete response
      hideMenu();
      updateClear();
      input.focus();
    }
    clearBtn.addEventListener('click', doClear);
    // Keep ONLY a mousedown preventDefault so a mouse-press doesn't blur the input
    // (which would hide the menu) before the click lands. Keyboard/touch are
    // unaffected: they reach doClear via the click handler above.
    clearBtn.addEventListener('mousedown', function (ev) { ev.preventDefault(); });

    function hideMenu() {
      menu.classList.remove('is-open');
      menu.setAttribute('aria-hidden', 'true');
      menu.textContent = '';
      names = [];
      active = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
    // Show the menu shell as a non-listbox message (no options, not focusable):
    // used for the "no results" feedback so a typed query never dead-ends silently.
    function showMessage(text) {
      menu.textContent = '';
      names = [];
      active = -1;
      var msg = el('div', 'mtg-search__msg', text);
      // The visible row is itself a polite status so it is announced in place...
      msg.setAttribute('role', 'status');
      menu.appendChild(msg);
      // ...and mirror it to the shared live region (the menu can be aria-hidden or
      // skipped by some SR/browser pairings, so this guarantees the announcement).
      announce(text);
      menu.classList.add('is-open');
      menu.setAttribute('aria-hidden', 'false');
      input.setAttribute('aria-expanded', 'true');
      input.removeAttribute('aria-activedescendant');
    }
    function renderMenu(list) {
      names = list.slice(0, 12);
      active = -1;
      menu.textContent = '';
      if (!names.length) { hideMenu(); return; }
      for (var i = 0; i < names.length; i++) {
        (function (nm, idx) {
          var opt = el('button', 'mtg-search__opt', nm);
          opt.setAttribute('type', 'button');
          opt.setAttribute('role', 'option');
          opt.id = uid + '-opt-' + idx;
          // Out of the tab order (APG combobox pattern) but still pointer-clickable:
          // keyboard users drive the list from the input via the arrow keys.
          opt.setAttribute('tabindex', '-1');
          opt.setAttribute('aria-selected', 'false');
          opt.setAttribute('data-i', String(idx));
          // mousedown (not click) so it fires before the input blur hides the menu.
          opt.addEventListener('mousedown', function (ev) { ev.preventDefault(); choose(nm); });
          menu.appendChild(opt);
        })(names[i], i);
      }
      menu.classList.add('is-open');
      menu.setAttribute('aria-hidden', 'false');
      input.setAttribute('aria-expanded', 'true');
      input.removeAttribute('aria-activedescendant');
    }
    function setActive(i) {
      var opts = menu.querySelectorAll('.mtg-search__opt');
      if (!opts.length) return;
      if (i < 0) i = opts.length - 1;
      if (i >= opts.length) i = 0;
      active = i;
      for (var k = 0; k < opts.length; k++) {
        var on = (k === active);
        opts[k].classList.toggle('is-active', on);
        opts[k].setAttribute('aria-selected', on ? 'true' : 'false');
      }
      // Point the input's virtual focus at the active option for screen readers.
      input.setAttribute('aria-activedescendant', opts[active].id);
      try { opts[active].scrollIntoView({ block: 'nearest' }); } catch (e) {}
    }
    function choose(name) {
      input.value = name;
      updateClear();
      hideMenu();
      // Default action: open the printings overlay for the picked card. The overlay's
      // own field overrides this to reload the open overlay in place (see boot/ensureOverlay).
      if (typeof opts.onChoose === 'function') opts.onChoose(name, input);
      else openResults(name, input);
    }

    var run = debounce(function (term) {
      var my = ++token;
      autocomplete(term).then(function (list) {
        if (my !== token) return;             // a newer keystroke superseded this
        if (document.activeElement !== input) return;
        if (list && list.length) { renderMenu(list); return; }
        // Zero matches for a real query: surface a non-interactive message row
        // instead of leaving the user staring at an empty field with no feedback.
        showMessage('No cards match "' + term + '".');
      }).catch(function () { /* leave the menu as-is on a transient error */ });
    }, 180);

    input.addEventListener('input', function () {
      updateClear();
      var term = input.value.trim();
      if (term.length < 2) { token++; hideMenu(); return; }
      run(term);
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); if (names.length) setActive(active + 1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); if (names.length) setActive(active - 1); }
      else if (ev.key === 'Enter') {
        ev.preventDefault();
        if (active >= 0 && names[active]) choose(names[active]);
        else if (names.length) choose(names[0]);
        else if (input.value.trim().length >= 2) choose(input.value.trim());
      } else if (ev.key === 'Escape') {
        if (menu.classList.contains('is-open')) {
          ev.preventDefault();
          // Stop the open menu's Escape from bubbling to the document-level Escape
          // handler (which would call closeResults). In the in-overlay search this would
          // otherwise dismiss the menu AND the whole overlay on one keystroke; here the
          // first Escape only closes the popup, and a second Escape (menu now closed,
          // so this branch is skipped) is free to bubble up and close the overlay. The
          // topbar field has no overlay to guard, so swallowing this Escape is harmless.
          ev.stopPropagation();
          hideMenu();
        }
      }
    });
    input.addEventListener('blur', function () { setTimeout(hideMenu, 120); });

    // The form should never actually submit/navigate.
    var form = input.closest('form');
    if (form) form.addEventListener('submit', function (ev) { ev.preventDefault(); });

    // Expose a reset so the overlay can blank its in-overlay field (and close any open
    // menu) when it reopens for a different card from the topbar. Reuses this closure's
    // own hideMenu/updateClear so nothing is duplicated.
    input._mtgReset = function () { input.value = ''; token++; updateClear(); hideMenu(); };
  }
  wireCombobox._seq = 0;   // per-mount counter for unique listbox/option ids

  // ---- one document-level Escape handler for both layers ----
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    if (_lbOpen) { closeLightbox(); return; }
    if (_overlayOpen) { closeResults(); }
  });

  // ---- boot ----
  function boot() {
    var input = document.querySelector('.mtg-search__input');
    if (input) wireCombobox(input);   // topbar field: default onChoose opens the overlay
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
