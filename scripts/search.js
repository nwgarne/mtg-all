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
    return '$' + v.toFixed(2);
  }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms);
    };
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
    var row = el('div', 'card-tile');
    row.setAttribute('role', 'row');
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
    nameCell.setAttribute('role', 'cell');
    meta.appendChild(nameCell);
    var sub = el('div', 'card-tile__sub');
    sub.setAttribute('role', 'cell');
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
    price.setAttribute('role', 'cell');
    price.appendChild(el('span', 'lbl', 'TCG'));
    var pStr = fmtPrice(c.p), pfStr = fmtPrice(c.pf), txt;
    if (pStr && pfStr) txt = pStr + ' · foil ' + pfStr;
    else if (pStr) txt = pStr;
    else if (pfStr) txt = 'foil ' + pfStr;
    else txt = '-';
    price.appendChild(document.createTextNode(txt));
    row.appendChild(price);

    return row;
  }

  // ============================================================
  //  RESULTS OVERLAY
  // ============================================================
  var _overlay = null, _grid = null, _title = null, _count = null, _overlayOpen = false, _overlayOpener = null;
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
    var close = el('button', 'mtg-find__close', '×');
    close.setAttribute('type', 'button');
    close.setAttribute('aria-label', 'Close printings');
    close.addEventListener('click', closeResults);
    head.appendChild(titleWrap);
    head.appendChild(close);
    panel.appendChild(head);

    var body = el('div', 'mtg-find__body');
    _grid = el('div', 'mtg-find__grid');
    body.appendChild(_grid);
    panel.appendChild(body);

    ov.appendChild(panel);
    ov.addEventListener('click', function (ev) { if (ev.target === ov) closeResults(); });
    document.body.appendChild(ov);
    _overlay = ov;
    return ov;
  }
  function openResults(name, opener) {
    var ov = ensureOverlay();
    _overlayOpener = opener || null;
    _title.textContent = name;
    _count.textContent = 'Loading printings…';
    _grid.textContent = '';
    ov.classList.add('is-open');
    ov.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('mtg-find-lock');
    _overlayOpen = true;
    var close = ov.querySelector('.mtg-find__close');
    if (close) { try { close.focus(); } catch (e) {} }

    allPrintings(name).then(function (cards) {
      if (!_overlayOpen) return;
      if (!cards || !cards.length) { _count.textContent = 'No printings found.'; return; }
      var recs = cards.map(toRec);
      var sets = {};
      for (var i = 0; i < recs.length; i++) { if (recs[i].s) sets[recs[i].s] = 1; }
      var nSets = Object.keys(sets).length;
      var nPr = recs.length;
      var label = 'Printed in ' + nSets + ' set' + (nSets === 1 ? '' : 's');
      if (nPr !== nSets) label += ' · ' + nPr + ' printings';
      _count.textContent = label;
      var frag = document.createDocumentFragment();
      for (var j = 0; j < recs.length; j++) frag.appendChild(printingTile(recs[j]));
      _grid.textContent = '';
      _grid.appendChild(frag);
    }).catch(function () {
      if (!_overlayOpen) return;
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
  function wire(input) {
    var menu = el('div', 'mtg-search__menu');
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-hidden', 'true');
    input.parentNode.appendChild(menu);

    var names = [];      // current suggestions
    var active = -1;     // highlighted index
    var token = 0;       // guards out-of-order autocomplete responses

    function hideMenu() {
      menu.classList.remove('is-open');
      menu.setAttribute('aria-hidden', 'true');
      menu.textContent = '';
      names = [];
      active = -1;
      input.setAttribute('aria-expanded', 'false');
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
          opt.setAttribute('data-i', String(idx));
          // mousedown (not click) so it fires before the input blur hides the menu.
          opt.addEventListener('mousedown', function (ev) { ev.preventDefault(); choose(nm); });
          menu.appendChild(opt);
        })(names[i], i);
      }
      menu.classList.add('is-open');
      menu.setAttribute('aria-hidden', 'false');
      input.setAttribute('aria-expanded', 'true');
    }
    function setActive(i) {
      var opts = menu.querySelectorAll('.mtg-search__opt');
      if (!opts.length) return;
      if (i < 0) i = opts.length - 1;
      if (i >= opts.length) i = 0;
      active = i;
      for (var k = 0; k < opts.length; k++) opts[k].classList.toggle('is-active', k === active);
      try { opts[active].scrollIntoView({ block: 'nearest' }); } catch (e) {}
    }
    function choose(name) {
      input.value = name;
      hideMenu();
      openResults(name, input);
    }

    var run = debounce(function (term) {
      var my = ++token;
      autocomplete(term).then(function (list) {
        if (my !== token) return;             // a newer keystroke superseded this
        if (document.activeElement !== input) return;
        renderMenu(list);
      }).catch(function () { /* leave the menu as-is on a transient error */ });
    }, 180);

    input.addEventListener('input', function () {
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
        if (menu.classList.contains('is-open')) { ev.preventDefault(); hideMenu(); }
      }
    });
    input.addEventListener('blur', function () { setTimeout(hideMenu, 120); });

    // The form should never actually submit/navigate.
    var form = input.closest('form');
    if (form) form.addEventListener('submit', function (ev) { ev.preventDefault(); });
  }

  // ---- one document-level Escape handler for both layers ----
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    if (_lbOpen) { closeLightbox(); return; }
    if (_overlayOpen) { closeResults(); }
  });

  // ---- boot ----
  function boot() {
    var input = document.querySelector('.mtg-search__input');
    if (input) wire(input);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
