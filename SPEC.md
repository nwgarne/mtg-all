# mtg-all.dirtyshoulders.com - BUILD SPEC (contract)

A static site that browses **every Magic: the Gathering card by release year**, reusing the
visual layout of the deck-list page on decks.dirtyshoulders.com. "Years are the decks."
Prices are shown to everyone (NO login/gate). Vanilla JS only (no frameworks/build step).

## Where things live (build into this dir; it is rsynced to the web root as-is)

```
/home/nwgarne/work/mtg-all/site/
  index.html              # HOMEPAGE: grid of year cards
  <year>/index.html       # one shell page per year (generated; see below)
  scripts/home.js         # homepage renderer (fetch data/years.json)
  scripts/year.js         # year-page renderer (fetch data/<year>.json)
  styles/                 # COPIED from decks-astro already present: tokens.css, global.css,
                          #   card-tile.css, hero.css, button.css, stat-row.css
  styles/mtg-all.css      # NEW: site-specific styles (header, year grid, accordion) -> YOU write this
  data/years.json         # homepage data (already generated)
  data/<year>.json        # per-year card data (already generated, 34 files, 1993..2026)
```

Page URLs (served statically): `/` (homepage), `/<year>/` (e.g. `/2024/`). Each `<year>/index.html`
is a near-identical shell that loads `scripts/year.js`; the year is read from the URL path.

## HARD CONSTRAINTS (the site is behind a strict CSP)

- **script-src 'self'**: NO inline `<script>` blocks and NO inline event handlers (onclick=...).
  All JS must live in `scripts/*.js` and load via `<script src="/scripts/x.js" defer></script>`.
- **style-src 'self' 'unsafe-inline'**: inline `style="..."` attributes ARE allowed (use for the
  per-year title-card background image). External stylesheets load via `<link>`.
- **img-src** allows `https://cards.scryfall.io` (card images) and `data:`. Card images come from
  cards.scryfall.io URLs already in the data.
- Vanilla JS, no external libraries. Match the existing code style of
  `/home/nwgarne/garnersites-infra/sites/dirtyshoulders/decks-astro/public/scripts/decklist.js`.

## REUSE (match the decks look exactly)

- Copy the visual system from the already-present `styles/*.css` (link them in your HTML `<head>`):
  `tokens.css` (design tokens/vars), `global.css`, `card-tile.css` (the card tile look),
  `hero.css`, `button.css`, `stat-row.css`.
- READ these for reference on markup + behavior to mirror:
  - `/home/nwgarne/garnersites-infra/sites/dirtyshoulders/decks-astro/public/scripts/decklist.js`
    (how a card tile is built: `buildCardRow`; how a category block is built: `buildCatBlock`;
    the click-to-zoom lightbox behavior; the `.card-tile*` / `.deck-cat*` class names it produces).
  - `/home/nwgarne/garnersites-infra/sites/dirtyshoulders/decks-astro/src/styles/components/card-tile.css`
    (the classes your tiles must use so the styling applies: `.card-tile`, `.card-tile__name`,
    `.card-tile__img`/image, `.card-tile__meta`, the category header `.deck-cat`, `.deck-cat__head`,
    `.deck-cat__title`, `.deck-cat__count`, `.deck-cat__body`, `.deck-cat__chev`, the
    `.is-collapsed` modifier, etc. -- use the SAME class names so the copied CSS styles them).
- Produce DOM that uses those existing class names wherever possible so the copied CSS just works.
  Add only what is missing in `styles/mtg-all.css`.

## DATA SHAPES (already generated - do not regenerate)

`data/years.json`:
```json
{ "years": [
    { "year":"2024", "sets":93, "cards":12968, "value":1234567.8,
      "title": { "name":"Murktide Regent", "set":"...", "cn":"...",
                 "art":"https://cards.scryfall.io/art_crop/....jpg", "value":2299.99,
                 "u":"https://scryfall.com/card/..." } },
    ... (newest year first) ],
  "totalCards":115803, "generated":"2026-06-13" }
```
`data/<year>.json`:
```json
{ "year":"2024", "totalCards":12968,
  "categories": [
    { "name":"Legendary Creatures", "count":1687, "cards":[
        { "n":"Card Name", "s":"set", "cn":"123", "t":"Legendary Creature - Dragon",
          "m":"{2}{R}{R}", "r":"mythic", "p":"12.50", "pf":"30.00",
          "img":"https://cards.scryfall.io/small/....jpg",
          "big":"https://cards.scryfall.io/normal/....jpg",
          "u":"https://scryfall.com/card/..." }, ... ] },
    ... ] }
```
Field key: n=name, s=set code, cn=collector number, t=type line, m=mana cost, r=rarity,
p=usd price (string or null), pf=usd foil price (string or null), img=small image,
big=normal image (for zoom), u=scryfall card page url. Categories are already in display order.

## PAGE A - HOMEPAGE (`index.html` + `scripts/home.js` + styles)  [AGENT: HOMEPAGE]

- A hero (reuse `hero.css` look): big title like "MTG by year." and a one-line tagline
  ("Every Magic card, grouped by the year it released. <N> cards across 34 years.").
  Pull the total from `years.json.totalCards`.
- Below: a responsive grid of **year cards**, newest year first, one per year from `years.json`.
- Each **year card** mirrors the decks homepage deck-card look (READ
  `/home/nwgarne/garnersites-infra/sites/dirtyshoulders/decks-astro/src/pages/index.astro` and its
  `.deck-card*` styles in `hero.css`). It must show:
  - background image = that year's **title card art** (`title.art`) via an inline
    `style="background-image:url(...)"` (allowed by CSP). Cover, subtle dark overlay so text reads.
  - the **year** (big), the card count and set count (e.g. "12,968 cards / 93 sets"),
    and a small caption naming the title card and its price (e.g. "Top: Murktide Regent - $2,300").
  - the whole card is a link to `/<year>/`.
  - if `title` is null, fall back to a plain card (no bg image).
- home.js fetches `/data/years.json`, renders the grid, formats numbers with thousands separators
  and prices as `$1,234.56`.

## PAGE B - YEAR PAGE (`<year>/index.html` + `scripts/year.js` + styles)  [AGENT: YEAR PAGE]

- Shell `<year>/index.html`: same `<head>` (CSS links) + a header + an empty container, loads
  `scripts/year.js`. year.js reads the year from `location.pathname` (e.g. `/2024/` -> "2024"),
  fetches `/data/<year>.json`, and renders.
- Hero (reuse hero look): the **year** as the title, and a stat row (reuse `stat-row.css`):
  total cards, number of categories, and total nonfoil market value (sum of `p` across the year,
  formatted `$`). A "back to all years" link to `/`.
- Then the **categories as an ACCORDION**, in the given order. Each category is a collapsible block
  using the decks `.deck-cat` look: a header button (`.deck-cat__head`) showing the category name
  (`.deck-cat__title`), the count (`.deck-cat__count`, e.g. "1,687 cards"), and a chevron
  (`.deck-cat__chev`); and a body (`.deck-cat__body`) that holds the card tiles.
- **ACCORDION BEHAVIOR (the key requirement, DIFFERENT from decks):**
  - All categories start **collapsed**.
  - Clicking a category header **opens it AND auto-collapses any other open category** (only ONE
    open at a time). This is the opposite of the decks page (which keeps multiple open).
  - **Render-on-expand for performance:** a year can have ~13,000 cards and one category up to
    ~4,500. Do NOT render all tiles up front. Render a category's card tiles into its body only
    when it is opened; when it closes (because another opened, or it is toggled shut), **clear its
    body** (`body.innerHTML = ''`) so the DOM only ever holds the tiles of the single open category.
  - Use `loading="lazy"` on every card image so only on-screen images fetch.
- **Card tile** (mirror decks `buildCardRow` + `.card-tile` CSS so it looks identical): a lazy
  thumbnail image (`img` field), the card name (`.card-tile__name`), a meta line with set code +
  collector number + rarity, and the **price shown to everyone**: nonfoil `$p` and, when present,
  a foil price (e.g. "$12.50 · foil $30.00"); if `p` is null but `pf` present, show "foil $X";
  if both null show "-". Clicking a tile opens a **zoom lightbox** of the `big` image (mirror the
  decks decklist.js lightbox; close on click/escape). Each tile name also deep-links to `u`
  (Scryfall) via a small external-link affordance, but the main click zooms.
- Sort within a category is already done in the data (alphabetical by name).

## SHARED CHROME

Both pages get a slim top header (you write it in `mtg-all.css`): left = "MTG · by year" wordmark
linking to `/`; this is the only nav. Keep it minimal and on-brand with the decks tokens.

## DELIVERABLES per agent

- HOMEPAGE agent: write `site/index.html`, `site/scripts/home.js`, and the homepage + shared-header
  parts of `site/styles/mtg-all.css`.
- YEAR PAGE agent: write `site/scripts/year.js`, ONE template `site/2024/index.html` (the
  orchestrator will copy it to all 34 year folders), and the year-page + accordion parts of
  `site/styles/mtg-all.css`. (Coordinate: both append to mtg-all.css; keep your additions in
  clearly commented sections so they merge cleanly. Header/wordmark styles: HOMEPAGE agent owns
  those; YEAR PAGE agent may assume they exist.)

Test against the real generated data in `site/data/`. Do not run a build or deploy; the orchestrator
integrates, copies the year shell to all 34 folders, and deploys.
