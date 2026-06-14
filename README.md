# mtg-all

Source for **mtg-all.dirtyshoulders.com** - a static site that browses every Magic: the
Gathering card by **release year**. Years are the "decks": each year page groups that year's
cards into card-type categories as a collapsible accordion, reusing the deck-list layout from
decks.dirtyshoulders.com. Prices are shown to everyone (no login gate).

## What it does

- **Homepage** (`index.html` + `scripts/home.js`): a grid of 34 year cards (1993..2026), each
  backed by that year's highest-value card art (its "title card"), linking to `/<year>/`.
- **Year page** (`year-template.html` + `scripts/year.js`): the year's cards grouped by type
  (Legendary Creatures, Creatures, Planeswalkers, Artifacts, Enchantments, Instants, Sorceries,
  Lands, Other) into a single-open accordion. A **Set** selector scopes the year to All cards or any one set
  released that year (the "set deck inside the year"), and a **Sort** selector (Name, Price high
  to low, Rarity, Mana value) reorders cards within each type section. Card tiles show image,
  set/collector/rarity, and
  USD + foil price; click to zoom.
- **Card search** (`scripts/search.js`, in the topbar on every page): type a card name for Scryfall
  autocomplete, then pick one to open an overlay listing **every printing** (every set the card
  appeared in) with set name, year, collector number, rarity, and price, each zoomable (double-faced
  cards show front and back). This is the site's one live dependency: it queries the Scryfall API
  (allowed by `connect-src https://api.scryfall.com` in the Caddy CSP), rather than the prebuilt
  per-year data, so new printings appear without a rebuild.
- **Accordion behavior:** opening a category auto-collapses the others (one open at a time), and
  it **renders on expand** - a year can hold ~13,000 cards, so tiles are only mounted for the one
  open category (and cleared when it closes). The DOM never holds more than a single category's
  tiles. This is the deliberate difference from the decks page (which keeps categories persist-open).

## Data (not committed)

The per-year card data is **regenerated from Scryfall's bulk `default_cards` export** (the only
source that is printing-level and carries images + prices) by `gen_data.py`. The output
(`build/data/<year>.json` + `years.json`, ~43 MB) is git-ignored because it is fully reproducible.
The sibling repos `mtg-data` (oracle-level SQLite) and `mtg-setlists` (per-set lists) cannot drive
this site: neither has per-printing data with both images and prices.

## Build + deploy

```sh
./deploy.sh           # downloads the bulk export if absent, generates data, assembles build/,
                      # copies the year shell into each year folder, rsyncs to caddy01
```

Environment overrides: `BULK=/path/to/default-cards.json`, `DEPLOY_HOST`, `DEPLOY_PATH`.

## Auto-update

A weekly cron on admin01 (the control VM, which has SSH access to the private caddy01) reruns
`deploy.sh`, so new sets and refreshed prices appear without manual work:

    0 6 * * 0 /home/nwgarne/projects/mtg-all/deploy.sh >> /home/nwgarne/projects/mtg-all/deploy.log 2>&1

GitHub-hosted Actions runners cannot reach caddy01 (it is on a private network), so a cron is the
mechanism rather than a hosted workflow. A self-hosted runner could call the same `deploy.sh`.

## Serving (caddy01)

`caddy.snippet` is the Caddy site block (static file server, strict CSP that allows
`cards.scryfall.io` images and `api.scryfall.com` for the card-search requests, no auth). It is added to
`/etc/caddy/Caddyfile.d/dirtyshoulders.caddy`. Pre-create the log file before reloading, or Caddy
fails to start:

```sh
sudo install -o caddy -g caddy -m 644 /dev/null /var/log/caddy/dirtyshoulders-mtg-all.log
sudo systemctl reload caddy
```

`mtg-all.dirtyshoulders.com` resolves via the existing `*.dirtyshoulders.com` wildcard; TLS issues
automatically through caddy01's global Cloudflare DNS-01.

## QA

`qa/` is a headless Playwright harness that checks the site against the live origin: responsive
layout, the viewport windowing (virtualization), and touch targets. See `qa/README.md` for setup
and the known-good invocation.

```sh
cd qa && npm install        # or set CHROMIUM_PATH + PW_CORE_PATH (see qa/README.md)
node responsive.mjs && node windowing.mjs && node touch-targets.mjs
```

## Credits

Card data and images from [Scryfall](https://scryfall.com). Visual system (`styles/tokens.css`,
`global.css`, `card-tile.css`, `hero.css`, `button.css`, `stat-row.css`) adapted from the
decks.dirtyshoulders.com deck-list site.
