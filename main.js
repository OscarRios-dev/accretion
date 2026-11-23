// Main process: window, vault reading and the bridge to Obsidian.
// Security model: note content is untrusted (a vault can be cloned from anywhere),
// so every IPC handler validates its arguments and only touches files inside a
// configured vault. Attachments are served through the custom `vault:` protocol.
const { app, BrowserWindow, ipcMain, shell, dialog, Menu, screen, protocol, net, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { scanVault, countNotes, MEDIA_RE } = require('./scanner');

// Developer-only flags (screenshots / tests). Ignored in packaged builds.
const DEV = !app.isPackaged;
const argOf = (k) => (DEV ? (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null : null);
const shotArg = argOf('shot');
const vaultOverride = argOf('vault');

// Screenshot runs use a throwaway profile so they never touch the user's config or history.
if (shotArg) app.setPath('userData', path.join(require('os').tmpdir(), `accretion-shot-${process.pid}`));
if (!shotArg && !app.requestSingleInstanceLock()) app.quit();

protocol.registerSchemesAsPrivileged([
  { scheme: 'vault', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let win;
const watchers = new Map();
const attachIndex = new Map(); // vaultPath -> { lowercased name or rel -> rel }
const parseCache = new Map(); // vaultPath -> Map(rel -> parsed note) for incremental rescans
const MAX_NOTE_BYTES = 2 * 1024 * 1024;

const configPath = () => path.join(app.getPath('userData'), 'config.json');
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const keyOf = (p) => { const r = path.resolve(p); return CASE_INSENSITIVE ? r.toLowerCase() : r; };
const samePath = (a, b) => keyOf(a) === keyOf(b);
const str = (v, max = 4096) => (typeof v === 'string' && v.length <= max ? v : null);

// Some vaults use "invisible" names (e.g. U+3164 Hangul filler): show something readable.
function displayName(p) {
  const base = path.basename(p) || p;
  if (base.replace(/[\sㅤᅟᅠ​-‏⠀﻿]/g, '')) return base;
  const parent = path.basename(path.dirname(p));
  return { unnamed: true, parent };
}
const nameFor = (p) => {
  const n = displayName(p);
  if (typeof n === 'string') return n;
  const es = lang() === 'es';
  return (es ? 'Vault sin nombre' : 'Unnamed vault') + (n.parent ? (es ? ` (en ${n.parent})` : ` (in ${n.parent})`) : '');
};

// ───────────────────────── config ─────────────────────────
const DEFAULTS = { vaults: [], name: '', lang: 'auto', ignore: [] };
function loadConfig() {
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // Keep a copy of a broken config instead of silently overwriting it.
      try { fs.copyFileSync(configPath(), configPath() + '.broken-' + Date.now()); } catch { /* nothing to back up */ }
    }
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
  const out = { ...DEFAULTS, ...cfg };
  out.vaults = Array.isArray(out.vaults) ? out.vaults.filter((p) => typeof p === 'string' && path.isAbsolute(p)) : [];
  out.name = typeof out.name === 'string' ? out.name.slice(0, 40) : '';
  out.lang = ['auto', 'es', 'en'].includes(out.lang) ? out.lang : 'auto';
  out.ignore = Array.isArray(out.ignore) ? out.ignore.filter((s) => typeof s === 'string' && s.trim()).slice(0, 100) : [];
  const b = out.window && out.window.bounds;
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) out.window = null;
  return out;
}

// The app used to be called "Second Brain Galaxy": carry its settings and history over once.
function migrateFromOldName() {
  try {
    const dst = app.getPath('userData');
    const src = path.join(app.getPath('appData'), 'Second Brain Galaxy');
    if (fs.existsSync(path.join(dst, 'config.json')) || !fs.existsSync(path.join(src, 'config.json'))) return;
    fs.mkdirSync(dst, { recursive: true });
    fs.copyFileSync(path.join(src, 'config.json'), path.join(dst, 'config.json'));
    const ls = path.join(src, 'Local Storage');
    if (fs.existsSync(ls)) fs.cpSync(ls, path.join(dst, 'Local Storage'), { recursive: true });
  } catch (e) { console.error('Migration skipped:', e.message); }
}

let config;
let saveTimer = null;
function saveConfig() {
  if (vaultOverride) return; // never persist a test override
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(configPath()), { recursive: true });
      const tmp = configPath() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
      fs.renameSync(tmp, configPath()); // atomic replace
    } catch (e) { console.error('Could not save config:', e.message); }
  }, 150);
}
function lang() {
  if (config && config.lang !== 'auto') return config.lang;
  return (app.getLocale() || 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
}

// Vaults Obsidian knows about (from <appData>/obsidian/obsidian.json).
function obsidianVaults() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'obsidian', 'obsidian.json'), 'utf8'));
    return Object.values(j.vaults || {})
      .filter((v) => v && typeof v.path === 'string' && isDir(v.path))
      .sort((a, b) => (b.open ? 1 : 0) - (a.open ? 1 : 0) || (b.ts || 0) - (a.ts || 0))
      .map((v) => v.path);
  } catch { return []; }
}

// ───────────────────────── path safety ─────────────────────────
// Resolves rel inside the vault, following symlinks, and rejects anything that escapes it.
function insideVault(vaultPath, rel) {
  if (!str(vaultPath) || !str(rel)) return null;
  let root, full;
  try { root = fs.realpathSync.native(vaultPath); } catch { return null; }
  const candidate = path.resolve(root, rel);
  try { full = fs.realpathSync.native(candidate); } catch { full = candidate; } // may not exist yet
  const r = path.relative(root, full);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? full : null;
}
const knownVault = (p) => !!str(p) && config.vaults.some((v) => samePath(v, p));
const vaultFor = (p) => config.vaults.find((v) => samePath(v, p));

// ───────────────────────── scanning / watching ─────────────────────────
async function scanAll() {
  const out = [];
  for (const p of config.vaults) {
    if (!isDir(p)) continue;
    if (!parseCache.has(p)) parseCache.set(p, new Map());
    const { notes, attachments, truncated, errors } = await scanVault(p, { ignore: config.ignore, cache: parseCache.get(p) });
    attachIndex.set(p, attachments);
    out.push({ name: nameFor(p), path: p, notes, truncated, errors: errors.length });
  }
  return out;
}

let notifyTimer = null;
const notifyChange = () => {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => win && !win.isDestroyed() && win.webContents.send('vaults-changed'), 700);
};

function watchVaults() {
  for (const w of watchers.values()) { try { w.close(); } catch { /* already closed */ } }
  watchers.clear();
  for (const p of config.vaults) {
    if (!isDir(p)) continue;
    try {
      const w = fs.watch(p, { recursive: true }, (_ev, file) => {
        if (!file) return notifyChange();
        if (file.split(/[\\/]/).some((s) => s.startsWith('.'))) return;
        if (/\.md$/i.test(file) || MEDIA_RE.test(file) || !path.extname(file)) notifyChange();
      });
      // If the vault is deleted, moved or on a flaky drive, the watcher errors: never crash.
      w.on('error', () => {
        try { w.close(); } catch { /* */ }
        watchers.delete(p);
        if (win && !win.isDestroyed()) win.webContents.send('watch-lost', nameFor(p));
        notifyChange();
      });
      watchers.set(p, w);
    } catch { /* no live updates for this vault */ }
  }
}

async function vaultInfo(p) {
  const ok = isDir(p);
  return { path: p, name: nameFor(p), exists: ok, notes: ok ? await countNotes(p) : 0, obsidian: ok && isDir(path.join(p, '.obsidian')) };
}

async function addVaultPath(p) {
  p = path.resolve(p);
  if (!isDir(p)) return { ok: false, error: 'not-dir' };
  if (knownVault(p)) return { ok: true, path: p, already: true };
  const n = await countNotes(p, 1);
  if (!n && !isDir(path.join(p, '.obsidian'))) return { ok: false, error: 'no-notes' };
  config.vaults.push(p);
  saveConfig();
  watchVaults();
  return { ok: true, path: p };
}

// Only http(s) links leave the app, and only after an explicit click in the renderer.
function safeExternal(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') { shell.openExternal(u.href); return true; }
  } catch { /* invalid URL */ }
  return false;
}

// ───────────────────────── window ─────────────────────────
function windowBounds() {
  const b = config.window && config.window.bounds;
  if (!b) return { width: 1500, height: 920 };
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 80;
  });
  const size = { width: Math.max(900, b.width), height: Math.max(600, b.height) };
  return visible ? { ...size, x: b.x, y: b.y } : size;
}

function createWindow() {
  win = new BrowserWindow({
    ...windowBounds(),
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#000000',
    title: 'Accretion',
    icon: path.join(__dirname, 'app', 'icon.png'),
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 12 } }
      : { titleBarOverlay: { color: '#00000000', symbolColor: '#f4c38c', height: 34 } }),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      devTools: DEV,
    },
  });
  if (config.window && config.window.maximized) win.maximize();
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  win.once('ready-to-show', () => win.show());

  const saveBounds = () => {
    if (win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
    const prev = config.window && config.window.bounds;
    config.window = { bounds: win.isMaximized() && prev ? prev : win.getBounds(), maximized: win.isMaximized() };
    saveConfig();
  };
  let bt = null;
  const later = () => { clearTimeout(bt); bt = setTimeout(saveBounds, 800); };
  win.on('resize', later);
  win.on('move', later);
  win.on('close', saveBounds);

  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (DEV && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      win.webContents.toggleDevTools(); e.preventDefault();
    }
    if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r' && !input.shift)) {
      win.webContents.send('vaults-changed'); e.preventDefault();
    }
  });
  // The app never navigates or opens windows; links are handled by an explicit click → open-external.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-frame-navigate', (e) => { if (!e.isMainFrame) e.preventDefault(); });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());

  if (shotArg) {
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.level, e.message));
    const out = path.resolve(shotArg);
    const delay = Number(argOf('shot-delay') || 9000);
    setTimeout(async () => {
      try { fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG()); } catch (e) { console.error('capture failed:', e.message); }
      app.exit(0);
    }, delay);
  }
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

// ───────────────────────── IPC ─────────────────────────
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    // Only our own page may call the API.
    const url = e.senderFrame && e.senderFrame.url;
    if (!url || !url.startsWith('file:') || !url.endsWith('/app/index.html')) return null;
    return fn(...args);
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  if (!shotArg) migrateFromOldName();
  config = loadConfig();
  if (vaultOverride) config = { ...config, vaults: [path.resolve(vaultOverride)] };

  // Deny every permission request (camera, mic, notifications, geolocation…).
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  // vault://<index>/<rel> → an attachment inside a configured vault (media files only).
  protocol.handle('vault', (req) => {
    try {
      const u = new URL(req.url);
      const vp = config.vaults[Number(u.hostname.replace(/^v/, ''))];
      const rel = decodeURIComponent(u.pathname.replace(/^\//, ''));
      const full = vp && MEDIA_RE.test(rel) ? insideVault(vp, rel) : null;
      if (!full || !fs.existsSync(full)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(full).href);
    } catch { return new Response('Bad request', { status: 400 }); }
  });

  handle('scan', () => scanAll());
  handle('profile', () => ({ name: config.name, lang: config.lang, resolvedLang: lang(), ignore: config.ignore, platform: process.platform }));
  handle('set-name', (name) => {
    config.name = String(str(name, 200) || '').trim().slice(0, 40);
    saveConfig();
    return { name: config.name };
  });
  handle('set-lang', (l) => {
    if (['auto', 'es', 'en'].includes(l)) { config.lang = l; saveConfig(); }
    return { lang: config.lang, resolvedLang: lang() };
  });
  handle('set-ignore', (list) => {
    if (!Array.isArray(list)) return config.ignore;
    config.ignore = list.map((s) => str(s, 300)).filter((s) => s && s.trim()).map((s) => s.trim()).slice(0, 100);
    saveConfig();
    return config.ignore;
  });
  handle('toggle-fullscreen', () => win.setFullScreen(!win.isFullScreen()));
  handle('shot-mode', () => (shotArg ? argOf('shot-view') || 'default' : null));
  handle('read-note', async (vaultPath, rel) => {
    if (!knownVault(vaultPath) || !/\.md$/i.test(str(rel) || '')) return null;
    const full = insideVault(vaultFor(vaultPath), rel);
    if (!full) return null;
    try {
      const st = await fs.promises.stat(full);
      if (!st.isFile() || st.size > MAX_NOTE_BYTES) return null;
      return await fs.promises.readFile(full, 'utf8');
    } catch { return null; }
  });
  // Turns an attachment reference (![[img.png]] or ![](path)) into a vault:// URL.
  handle('resolve-attachment', (vaultPath, noteRel, target) => {
    if (!knownVault(vaultPath) || !str(noteRel) || !str(target)) return null;
    const vp = vaultFor(vaultPath);
    const idx = config.vaults.indexOf(vp);
    let t = target.split('|')[0].split('#')[0].trim();
    try { t = decodeURIComponent(t); } catch { /* as is */ }
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) || !MEDIA_RE.test(t)) return null;
    const toUrl = (rel) => `vault://v${idx}/${rel.split('/').map(encodeURIComponent).join('/')}`;
    for (const r of [path.posix.join(path.posix.dirname(noteRel), t), t]) {
      const full = insideVault(vp, r);
      if (full && fs.existsSync(full)) return toUrl(path.relative(fs.realpathSync.native(vp), full).split(path.sep).join('/'));
    }
    const map = attachIndex.get(vp) || {};
    const hit = map[t.toLowerCase()] || map[path.posix.basename(t).toLowerCase()];
    return hit ? toUrl(hit) : null;
  });
  handle('open-in-obsidian', (vaultPath, rel) => {
    if (!knownVault(vaultPath)) return false;
    const full = insideVault(vaultFor(vaultPath), rel);
    if (!full) return false;
    return shell.openExternal(`obsidian://open?path=${encodeURIComponent(full)}`).then(() => true, () => false);
  });
  handle('reveal-note', (vaultPath, rel) => {
    if (!knownVault(vaultPath)) return;
    const full = insideVault(vaultFor(vaultPath), rel);
    if (full) shell.showItemInFolder(full);
  });
  handle('open-external', (url) => safeExternal(str(url)));
  handle('open-folder', (p) => { if (knownVault(p) && isDir(p)) shell.openPath(vaultFor(p)); });
  handle('vaults', () => Promise.all(config.vaults.map(vaultInfo)));
  handle('detect-vaults', () => Promise.all(obsidianVaults().filter((p) => !knownVault(p)).map(vaultInfo)));
  handle('add-vault', async (p) => {
    const es = lang() === 'es';
    if (p == null) {
      const r = await dialog.showOpenDialog(win, { title: es ? 'Elige la carpeta de tu vault' : 'Choose your vault folder', properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
      return addVaultPath(r.filePaths[0]);
    }
    if (!str(p) || !path.isAbsolute(p)) return { ok: false, error: 'not-dir' };
    // Paths that come from the page (drag & drop, suggestions) must be a known Obsidian
    // vault or be confirmed by the user in a native dialog the page cannot fake.
    if (!obsidianVaults().some((v) => samePath(v, p))) {
      const r = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: es ? ['Añadir', 'Cancelar'] : ['Add', 'Cancel'],
        defaultId: 0, cancelId: 1,
        message: es ? '¿Añadir esta carpeta como vault?' : 'Add this folder as a vault?',
        detail: path.resolve(p),
      });
      if (r.response !== 0) return { ok: false, canceled: true };
    }
    return addVaultPath(p);
  });
  // Bundled demo vault (unpacked from the asar so it can be read and watched like any folder).
  handle('add-demo', () => {
    const demo = path.join(__dirname.replace(/app\.asar$/, 'app.asar.unpacked'), 'examples', 'sample-vault');
    return isDir(demo) ? addVaultPath(demo) : { ok: false, error: 'not-dir' };
  });
  handle('remove-vault', (p) => {
    if (!str(p)) return false;
    config.vaults = config.vaults.filter((v) => !samePath(v, p));
    for (const m of [attachIndex, parseCache]) for (const k of m.keys()) if (samePath(k, p)) m.delete(k);
    saveConfig();
    watchVaults();
    return true;
  });
  // Saves a PNG of the galaxy chosen by the user (wallpaper / sharing).
  handle('save-image', async (dataUrl) => {
    if (!str(dataUrl, 80 * 1024 * 1024) || !dataUrl.startsWith('data:image/png;base64,')) return { ok: false };
    const es = lang() === 'es';
    const r = await dialog.showSaveDialog(win, {
      title: es ? 'Guardar captura' : 'Save screenshot',
      defaultPath: path.join(app.getPath('pictures'), `galaxy-${new Date().toISOString().slice(0, 10)}.png`),
      filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    await fs.promises.writeFile(r.filePath, Buffer.from(dataUrl.slice(22), 'base64'));
    return { ok: true, path: r.filePath };
  });

  createWindow();
  watchVaults();
});

app.on('window-all-closed', () => app.quit());
