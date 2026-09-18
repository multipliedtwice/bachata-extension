# Docs site

`public/` = GitHub Pages site. Plain HTML + CSS, no build. Deploy: `.github/workflows/docs-pages.yml` on push to `main` touching `docs-site/public/**`. Repo Settings → Pages → Source must be "GitHub Actions".

Preview: serve parent of `extension/` and `browser-bridge/`, open `extension/docs-site/public/index.html`.

```bash
cd /path/to/pair && python3 -m http.server 8765 --bind 127.0.0.1
```

## Screenshots

`public/img/*.png` = real UI, demo data. Not release screenshots; `media/screenshots/` rules unchanged.

- Webview shots: build extension (`dist/webview.js`), open `capture/index.html`, run `await __show("<scene>")` in console. Scenes in `capture/scenes.js`: `composer`, `contract`, `pipelinePicker`, `agents`, `agentsBrowser`, `bridgePairing`, `transcript`, `execution`, `direction`, `editor`. Reload page between scenes. Viewport 1280x800, DPR 2. Blur focus before capture.
- Extra clicks after scene: result detail = `[data-action="result-details-toggle"]`; run contract = open `Run details` disclosure; run drawer + direction = direction scene opens drawer, then `.run-drawer-direction`.
- Bridge popup shots: build bridge (`browser-bridge/dist`), inject `capture/bridge-popup-stub.js` before page scripts (Chrome MCP `initScript`), open `browser-bridge/dist/popup/index.html#<state>`, state = `disconnected` | `connected` | `bound`. Viewport 380 wide, dark scheme. Full reload per state; hash change alone keeps old state.
- Theme colors from `tests/fixtures/webview-layout/theme-colors.json` (VS Code Dark Modern). Base state from `tests/fixtures/webview-layout/fixture.js`.
- UI changes → recapture affected shots.
