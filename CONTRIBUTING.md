# Contributing

Thanks for helping! Issues and pull requests are welcome.

## Setup

```bash
npm ci          # install exact dependencies
npm start       # build the renderer bundle and launch the app
npm test        # parser, graph, layout, search and stats tests (Node's built-in runner)
npm run check   # tests + translation check + build (what CI runs)
```

Try your changes against the bundled demo vault: `npm run demo`.

## Project layout

| Path | What it does |
| --- | --- |
| `main.js` | Electron main process: window, config, IPC (validated), `vault://` protocol, file watching |
| `preload.js` | The small typed API exposed to the page as `window.brain` |
| `scanner.js` | Reads a vault: frontmatter, tags, links, headings, tasks (no Electron dependency, unit-tested) |
| `src/renderer.js` | Scene, camera, labels, panels, search UI, settings (three.js + DOM) |
| `src/model.mjs` | Pure graph + layout: link resolution, groups, grid-accelerated layout, search, neighbourhoods |
| `src/stats.mjs` | Pure statistics: `computeStats(model)` + HTML renderers. **Add new stats here.** |
| `src/markdown.mjs` | Safe note rendering (marked + DOMPurify), callouts, attachments |
| `src/i18n.mjs`, `src/locales/es.mjs` | Strings. English is the key; add the Spanish translation (`npm run i18n:check`). |
| `src/lens.js` | Ray-traced Schwarzschild black hole (post-processing shader) |
| `app/` | `index.html`, `style.css`, icon |
| `examples/sample-vault/` | Harmless demo vault (regenerate with `node scripts/make-sample-vault.js`) |

## Guidelines

- **Never write to the user's vault.** The app is read-only by design.
- Treat note content as untrusted (see `SECURITY.md`). Escape with `esc()` when building HTML; markdown goes through `renderMd()` which sanitizes.
- Keep the look: near-black, glass panels, 1px borders, one periwinkle accent (`--accent`). Use the CSS tokens in `app/style.css` instead of new colors or font sizes.
- Write UI strings in English inside `t('…')` and add the Spanish translation to `src/locales/es.mjs`.
- Statistics must be honest: label exactly what is measured and give every chart an empty state.
- Keep dependencies minimal; there is no framework on purpose.

## Releasing

1. Bump `version` in `package.json` and add a `## x.y.z` section to `CHANGELOG.md`.
2. `npm run check`, commit and push.
3. `git tag -a vx.y.z -m "Accretion x.y.z" && git push origin vx.y.z`

The *Release* workflow builds Windows, macOS and Linux on their own runners, adds `SHA256SUMS.txt` and publishes the GitHub Release with the changelog notes. Local builds: `npm run package` (Windows), `package:mac`, `package:linux` → `dist/<version>/`.
