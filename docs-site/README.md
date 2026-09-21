# Docs site

`public/` = GitHub Pages site. Plain HTML + CSS, no build. Deploy: `.github/workflows/docs-pages.yml` on push to `main` touching `docs-site/public/**`. Repo Settings → Pages → Source must be "GitHub Actions".

Preview: serve parent of `extension/` and `browser-bridge/`, open `extension/docs-site/public/index.html`.

```bash
cd /path/to/pair && python3 -m http.server 8765 --bind 127.0.0.1
```

## Languages

`public/index.html` = English source, hand-edited. Locale pages are generated: `public/<locale>/index.html` for `ru`, `zh-cn`, `pt-br`, `th`, `de`.

```bash
cd docs-site/i18n
node build.mjs --extract   # refresh en.json after editing index.html
node build.mjs             # write locale pages, hreflang links, sitemap.xml
```

- `i18n/en.json` = extracted source strings (text nodes plus `alt`, `title`, `aria-label`, `placeholder` and the translated `meta`/`og` fields). Keys are the English strings.
- `i18n/<locale>.json` = translations, same keys. A key missing from a locale file stays English in that page, so edit `index.html` first, re-extract, then fill the new keys.
- `build.mjs` is idempotent: it strips the generated `hreflang` links and language switcher before rendering, so repeated runs do not stack them.
- Editing `index.html` invalidates only the keys whose English text changed.
- Locale images live in `public/img/<locale>/`; English images stay in `public/img/`.

## Screenshots

`public/img/*.png` = real UI, demo data. Not release screenshots; `media/screenshots/` rules unchanged.

- Localized shots: open `capture/index.html?locale=<locale>` and the harness loads `l10n/bundle.l10n.<locale>.json` into the webview before it renders. Capture the same scenes into `public/img/<locale>/`. The Browser Bridge popup has no localization, so every locale reuses the English popup shots.
- Webview shots: build extension (`dist/webview.js`), open `capture/index.html`, run `await __show("<scene>")` in console. Scenes in `capture/scenes.js`: `composer`, `contract`, `pipelinePicker`, `agents`, `agentsBrowser`, `bridgePairing`, `transcript`, `execution`, `direction`, `editor`. Reload page between scenes. Viewport 1280x800, DPR 2. Blur focus before capture.
- Extra clicks after scene: result detail = `[data-action="result-details-toggle"]`; run details = `[data-action="inspector-toggle"]`; run drawer + direction = direction scene opens drawer, then `.run-drawer-direction`.
- Bridge popup shots: build bridge (`browser-bridge/dist`), inject `capture/bridge-popup-stub.js` before page scripts (Chrome MCP `initScript`), open `browser-bridge/dist/popup/index.html#<state>`, state = `disconnected` | `connected` | `bound`. Viewport 380 wide, dark scheme. Full reload per state; hash change alone keeps old state.
- Theme colors from `tests/fixtures/webview-layout/theme-colors.json` (VS Code Dark Modern). Base state from `tests/fixtures/webview-layout/fixture.js`.
- UI changes → recapture affected shots.
