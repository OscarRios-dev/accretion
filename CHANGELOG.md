# Changelog

## 2.2.0 — first public release

### Added
- **Statistics tab**: activity map (12 months), growth curve, weekly rhythm, network health, central notes, bridges, broken links ("notes to write"), tags and tag pairs, group comparison, length, freshness, tasks, and a "To review" list.
- Honest **Home dashboard** (dates corrected for copied/synced vaults, every sparkline labelled).
- **Filters** (tags, groups/legend, edited in the last N days, orphans) and **search highlighting on the map** (`Shift+Enter`).
- **Neighbourhood depth** for the selected note (`1`, `2`, `0`).
- **Time travel** slider with playback (`T`).
- **Pinned notes** (`F`), **screenshot export** (`S`), hover previews, note insights.
- **English and Spanish** UI with automatic detection.
- **Sample vault** to try the app without Obsidian.
- Ignored folders setting, graphics quality preset, `prefers-reduced-motion` support.
- Keyboard and screen-reader accessibility: focus rings, dialog semantics, focus trapping, labelled controls.
- Unit tests (parser, graph, layout, search, stats) and CI on Windows, macOS and Linux.

### Security
- Notes are sanitized with DOMPurify; strict Content-Security-Policy; attachments served through a confined `vault://` protocol.
- IPC arguments validated; symlinks escaping a vault are rejected; permission requests denied; external links only on click.
- Developer flags and DevTools disabled in packaged builds; Electron fuses flipped.

### Performance
- Scanner with bounded concurrency (no more silently skipped notes on large vaults) and an incremental cache.
- Linear-time parsing (a hostile note can no longer freeze the app).
- Layout repulsion uses a spatial grid (20k-note group: ~0.6 s instead of minutes).
- Pre-normalised search, capped labels, cheaper star shader, smaller sky cubemap, adaptive quality that also recovers.

## 2.1.0
- Fixed the "Add vault" button on the empty screen; vault manager, onboarding and auto-detection of Obsidian vaults.
