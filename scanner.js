// Reads an Obsidian vault and returns its notes with tags, links and metadata.
// Pure Node (no Electron) so it can be unit-tested: `node --test`.
//  - bounded concurrency (no EMFILE on big vaults, works with macOS' 256 fd limit)
//  - incremental: unchanged files (same mtime + size) are reused from a cache
//  - linear-time regexes (a hostile note cannot freeze the app)
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const SKIP_DIRS = new Set(['node_modules']);
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_NOTES = 50000;
const TEXT_CHARS = 4000;
const CONCURRENCY = 32;
const MEDIA_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|pdf|mp3|wav|m4a|ogg|flac|mp4|webm|mov|base|canvas)$/i;

// Wiki links: no brackets/newlines inside and a length cap → linear time.
const WIKI_RE = /(!?)\[\[([^\[\]\n|#^]{1,300})((?:[#^][^\[\]\n|]{0,300})?)(?:\\?\|([^\[\]\n]{0,300}))?\]\]/g;
const MDLINK_RE = /\]\(<?([^()<>\s]{1,500}\.md)>?\)/g;
const TAG_RE = /(?:^|[\s(,;])#([\p{L}\p{N}\p{Extended_Pictographic}_\/-]{1,120})/gu;

function stripInlineComment(s) {
  // "tags: [a, b]   # optional" -> "tags: [a, b]"
  return s.replace(/\s+#\s.*$/, '').trim();
}
const unquote = (s) => s.trim().replace(/^["']|["']$/g, '').trim();

// Splits "a, 'b, c', d" respecting quotes.
function splitList(s) {
  const out = [];
  let cur = '', q = null;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// key: [a, b] | key: a, b | key: single value | key:\n  - a\n  - b
function parseYamlList(lines, key, { spaceSeparated = false } = {}) {
  const out = [];
  const re = new RegExp('^' + key + '\\s*:\\s*(.*)$', 'i');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const rest = stripInlineComment(m[1]);
    if (rest.startsWith('[')) splitList(rest.replace(/^\[|\]$/g, '')).forEach((t) => out.push(t));
    else if (rest) (spaceSeparated ? rest.split(/[,\s]+/) : splitList(rest)).forEach((t) => out.push(t));
    else {
      for (let j = i + 1; j < lines.length; j++) {
        const li = lines[j].match(/^\s*-\s*(.+)$/);
        if (!li) break;
        out.push(stripInlineComment(li[1]));
      }
    }
  }
  return out.map((t) => unquote(t).replace(/^#+/, '')).filter(Boolean);
}

function yamlScalar(lines, key) {
  const re = new RegExp('^' + key + '\\s*:\\s*(.+)$', 'i');
  for (const l of lines) {
    const m = l.match(re);
    if (m) return unquote(stripInlineComment(m[1])) || null;
  }
  return null;
}
const toTime = (s) => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) && t > 0 ? t : null;
};

// Blanks out code, comments and math while keeping line structure, so tags,
// links and headings inside them are ignored.
function maskNonProse(body) {
  const src = body.split('\n');
  const out = new Array(src.length);
  let fence = null;
  let inIndented = false;
  let prevBlank = true;
  let inList = false;
  for (let i = 0; i < src.length; i++) {
    const l = src[i];
    if (fence) {
      if (l.trimStart().startsWith(fence)) fence = null;
      out[i] = '';
      continue;
    }
    const f = /^\s{0,3}(```+|~~~+)/.exec(l);
    if (f) { fence = f[1][0].repeat(f[1].length); out[i] = ''; prevBlank = false; continue; }
    const blank = !l.trim();
    if (/^\s*([-*+]|\d+[.)])\s/.test(l)) inList = true;
    else if (blank) { /* keep list state across blank lines */ }
    else if (!/^\s/.test(l)) inList = false;
    // Indented code: 4 spaces / tab after a blank line, outside lists.
    const indented = /^( {4}|\t)/.test(l) && !blank;
    if (indented && !inList && (prevBlank || inIndented)) { inIndented = true; out[i] = ''; continue; }
    if (!blank) inIndented = false;
    prevBlank = blank;
    out[i] = l;
  }
  return out.join('\n')
    .replace(/`[^`\n]*`/g, ' ')
    // %% Obsidian comments %% and <!-- HTML comments --> (may span lines)
    .replace(/%%[\s\S]*?(?:%%|$)/g, ' ')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
}

function parseNote(raw) {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // BOM
  const norm = text.replace(/\r\n?/g, '\n');
  let fm = '';
  let body = norm;
  const fmMatch = norm.match(/^---\n([\s\S]*?)\n---[ \t]*(\n|$)/);
  if (fmMatch) {
    fm = fmMatch[1];
    body = norm.slice(fmMatch[0].length);
  }
  const fmLines = fm.split('\n');
  const tags = new Set(parseYamlList(fmLines, 'tags', { spaceSeparated: true }).concat(parseYamlList(fmLines, 'tag', { spaceSeparated: true })).map((t) => t.toLowerCase()));
  const aliases = parseYamlList(fmLines, 'aliases').concat(parseYamlList(fmLines, 'alias'));
  const fmTitle = yamlScalar(fmLines, 'title');
  const created = toTime(yamlScalar(fmLines, 'created') || yamlScalar(fmLines, 'date') || yamlScalar(fmLines, 'creation_date'));

  const clean = maskNonProse(body);
  for (const m of clean.matchAll(TAG_RE)) {
    const t = m[1].replace(/\/+$/, '').toLowerCase();
    if (t && !/^\d+$/.test(t)) tags.add(t); // Obsidian: a tag needs at least one non-digit
  }

  const links = new Set();
  let embeds = 0;
  for (const m of clean.matchAll(WIKI_RE)) {
    const t = m[2].replace(/\\$/, '').trim(); // "[[Note\|alias]]" inside tables
    if (!t) continue;
    if (MEDIA_RE.test(t)) { if (m[1]) embeds++; continue; }
    links.add(t);
  }
  for (const m of clean.matchAll(MDLINK_RE)) {
    if (/^[a-z]+:/i.test(m[1])) continue;
    try { links.add(decodeURIComponent(m[1]).replace(/\.md$/i, '').replace(/^(\.\/)+/, '')); } catch { /* ignore */ }
  }

  const h1 = clean.match(/^#\s+(.+)$/m);
  const headings = (clean.match(/^#{1,6}\s+\S/gm) || []).length;
  // Only the start of the note is kept for search/snippets; bounded, bracket-free classes keep this linear.
  const plain = clean.slice(0, TEXT_CHARS * 3)
    .replace(/!\[\[[^\[\]\n]{0,300}\]\]/g, ' ')
    .replace(/\[\[([^\[\]|\n]{1,300}?)\\?\|([^\[\]\n]{1,300})\]\]/g, '$2')
    .replace(/\[\[([^\[\]\n]{1,300})\]\]/g, '$1')
    .replace(/!?\[([^\[\]\n]{0,300})\]\([^()\n]{0,500}\)/g, '$1')
    .replace(/<[^>\n]{1,200}>/g, ' ')
    .replace(/^[\s>#*-]+|[*_`|>#=~]+/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TEXT_CHARS);
  const words = (clean.match(/[\p{L}\p{N}]+/gu) || []).length;
  const tasksOpen = (body.match(/^\s*[-*+] \[ \]/gm) || []).length;
  const tasksDone = (body.match(/^\s*[-*+] \[[xX]\]/gm) || []).length;
  const urls = (clean.match(/https?:\/\/[^\s)>\]]+/g) || []).length;

  return {
    title: fmTitle || (h1 ? h1[1].replace(/[*_`[\]]/g, '').trim() : null),
    tags: [...tags],
    aliases,
    links: [...links],
    words,
    headings,
    text: plain,
    tasksOpen,
    tasksDone,
    created,
    embeds,
    urls,
  };
}

// Ignore patterns: "Templates", "95-Privado/", "*.excalidraw", "Archive/**".
function makeIgnore(patterns = []) {
  const res = patterns.map((p) => p.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean).map((p) => {
    if (!/[*?]/.test(p)) return (rel) => rel === p || rel.startsWith(p + '/') || rel.split('/').includes(p);
    const rx = new RegExp('^' + p.split('**').map((s) => s.split('*').map((x) => x.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('[^/]*')).join('.*') + '$', 'i');
    return (rel) => rx.test(rel) || rx.test(rel.split('/').pop());
  });
  return (rel) => res.some((f) => f(rel));
}

// Tiny semaphore: at most n async jobs at once.
function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, res, rej } = queue.shift();
    fn().then(res, rej).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((res, rej) => { queue.push({ fn, res, rej }); next(); });
}

/**
 * @param {string} root vault folder
 * @param {{ignore?: string[], cache?: Map}} opts cache maps rel -> {mtime,size,note}; pass the same Map between scans
 */
async function scanVault(root, { ignore = [], cache = null } = {}) {
  const isIgnored = makeIgnore(ignore);
  const limit = limiter(CONCURRENCY);
  const notes = [];
  const errors = [];
  const attachments = {}; // lowercased name or rel -> rel
  const seen = new Set();
  let truncated = false;

  const files = [];
  const walk = async (dir, rel) => {
    let entries;
    try { entries = await limit(() => fsp.readdir(dir, { withFileTypes: true })); } catch (e) { errors.push({ rel: rel || '.', code: e.code }); return; }
    const subdirs = [];
    for (const ent of entries) {
      if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name) || ent.isSymbolicLink()) continue;
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (isIgnored(r)) continue;
      if (ent.isDirectory()) { subdirs.push([path.join(dir, ent.name), r]); continue; }
      if (!ent.isFile()) continue;
      const lower = ent.name.toLowerCase();
      if (lower.endsWith('.md')) {
        if (files.length >= MAX_NOTES) { truncated = true; continue; }
        files.push([path.join(dir, ent.name), r, ent.name]);
      } else if (MEDIA_RE.test(lower)) {
        if (!attachments[lower]) attachments[lower] = r;
        attachments[r.toLowerCase()] = r;
      }
    }
    await Promise.all(subdirs.map(([d, r]) => walk(d, r)));
  };
  await walk(root, '');

  await Promise.all(files.map(([full, r, fname]) => limit(async () => {
    try {
      const st = await fsp.stat(full);
      if (st.size > MAX_BYTES) return;
      seen.add(r);
      const hit = cache && cache.get(r);
      let info;
      if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) info = hit.info;
      else {
        info = parseNote(await fsp.readFile(full, 'utf8'));
        if (cache) cache.set(r, { mtime: st.mtimeMs, size: st.size, info });
      }
      const name = fname.replace(/\.md$/i, '');
      const slash = r.indexOf('/');
      notes.push({
        rel: r,
        name,
        title: info.title || name,
        folder: slash > 0 ? r.slice(0, slash) : '',
        tags: info.tags,
        aliases: info.aliases,
        links: info.links,
        words: info.words,
        headings: info.headings,
        text: info.text,
        tasksOpen: info.tasksOpen,
        tasksDone: info.tasksDone,
        embeds: info.embeds,
        urls: info.urls,
        created: info.created,
        ctime: st.birthtimeMs || st.ctimeMs,
        mtime: st.mtimeMs,
      });
    } catch (e) { errors.push({ rel: r, code: e.code || 'PARSE' }); }
  })));
  if (cache) for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);
  notes.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { notes, attachments, errors, truncated };
}

// Fast note count (with a cap) to show suggestions without reading the whole vault.
async function countNotes(root, cap = 5000) {
  let n = 0;
  const walk = async (dir, depth) => {
    if (n >= cap || depth > 40) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (n >= cap) return;
      if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name) || ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) await walk(path.join(dir, ent.name), depth + 1);
      else if (ent.name.toLowerCase().endsWith('.md')) n++;
    }
  };
  await walk(root, 0);
  return n;
}

module.exports = { scanVault, countNotes, parseNote, makeIgnore, MEDIA_RE };
