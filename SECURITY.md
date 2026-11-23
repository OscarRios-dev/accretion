# Security policy

## Threat model

Accretion is a **read-only, offline** viewer. It never writes to your vault and makes no network requests of its own.

Note content is treated as **untrusted**: a vault may be cloned or shared by someone else. Because of that:

- Rendered markdown is sanitized with DOMPurify (no scripts, iframes, forms, `<meta>`, `<base>`, `<style>` or inline styles).
- A strict Content-Security-Policy blocks remote scripts, frames, forms and `file:` URLs.
- Attachments are served through a custom `vault://` protocol that only returns media files located inside a configured vault (symlinks that escape the vault are rejected).
- Every IPC handler validates its arguments and only touches files inside configured vaults. Paths added from the page (drag & drop) need confirmation in a native dialog unless Obsidian already lists them.
- External links open in your browser only after you click them, and only for `http(s)`.
- The renderer runs with `contextIsolation`, `sandbox` and no Node integration. All permission requests (camera, microphone, notifications…) are denied.
- Developer flags (`--shot`, `--vault`) and DevTools are disabled in packaged builds.

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's *Report a vulnerability* button (Security → Advisories) on this repository, with steps to reproduce (a minimal malicious note is ideal). You should get an answer within 7 days.
