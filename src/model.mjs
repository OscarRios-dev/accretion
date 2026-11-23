// Builds the graph + galaxy layout from scanned vaults. Pure (no DOM / three.js) and unit-tested.
import { hashStr, rng, gauss, clamp, norm, prettyName } from './util.mjs';

export const DISC_IN = 215;
export const DISC_OUT = 640;
const MIN_DIST = 18;          // minimum distance between two stars of the same group
const RELAX_PASSES = 12;      // repulsion passes (grid-accelerated, linear per pass)
export const ROOT = '\u0000root'; // group key for notes at the vault root (cannot collide with a folder name)

/**
 * @param {Array<{name,path,notes}>} data scanned vaults
 * @param {{active?: number[], groupBy?: 'folder'|'tag', rootLabel?: string, untaggedLabel?: string}} opts
 */
export function buildModel(data, { active = null, groupBy = 'folder', untaggedLabel = 'untagged' } = {}) {
  const vis = active && active.length ? active : data.map((_, i) => i);
  const notes = [];
  const consts = new Map();
  vis.forEach((vi, si) => {
    const v = data[vi];
    for (const n of v.notes) {
      let key, label;
      if (groupBy === 'tag') {
        key = n.tags[0] ? n.tags[0].split('/')[0] : '\u0000untagged';
        label = n.tags[0] ? '#' + key : untaggedLabel;
      } else {
        key = n.folder || ROOT;
        label = n.folder ? prettyName(n.folder) : v.name;
      }
      const ck = v.path + '|' + key;
      if (!consts.has(ck)) consts.set(ck, { key: ck, name: key, label, vault: vi, slot: si, notes: [] });
      const c = consts.get(ck);
      const node = {
        ...n, id: v.path + '|' + n.rel, vault: vi, vaultName: v.name, vaultPath: v.path, c,
        out: new Set(), inn: new Set(),
        // pre-normalised fields so search does no work per keystroke
        _title: norm(n.title), _names: norm(n.name + ' ' + n.aliases.join(' ')), _body: norm(n.text), _tags: n.tags.join(' '),
      };
      c.notes.push(node);
      notes.push(node);
    }
  });

  // Link resolution like Obsidian: full path, then file name, then aliases (a real name always wins).
  const lookup = new Map();
  for (const tier of [0, 1, 2]) {
    for (const n of notes) {
      let m = lookup.get(n.vault);
      if (!m) lookup.set(n.vault, (m = new Map()));
      const add = (k) => { k = norm(k); if (!m.has(k)) m.set(k, n); };
      if (tier === 0) add(n.rel.replace(/\.md$/i, ''));
      else if (tier === 1) add(n.name);
      else n.aliases.forEach(add);
    }
  }
  const resolve = (vault, target) => {
    const m = lookup.get(vault);
    if (!m) return null;
    const k = norm(String(target).replace(/\.md$/i, '').replace(/^\/+/, ''));
    return m.get(k) || m.get(k.split('/').pop()) || null;
  };

  const edges = [];
  const seen = new Set();
  for (const n of notes) {
    for (const l of n.links) {
      const t = resolve(n.vault, l);
      if (!t || t === n) continue;
      n.out.add(t);
      t.inn.add(n);
      const ek = n.id < t.id ? n.id + '>' + t.id : t.id + '>' + n.id;
      if (!seen.has(ek)) { seen.add(ek); edges.push([n, t]); }
    }
  }

  // Groups become sectors of the disc around the black hole.
  const list = [...consts.values()].sort((a, b) => a.slot - b.slot || b.notes.length - a.notes.length || a.label.localeCompare(b.label));
  const weights = list.map((c) => 0.8 + Math.sqrt(c.notes.length));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = -Math.PI / 2;
  list.forEach((c, k) => {
    const span = (weights[k] / total) * Math.PI * 2;
    const rr = rng(hashStr(c.key));
    c.index = k;
    c.ang = acc + span / 2;
    acc += span;
    c.span = span;
    c.rMid = DISC_IN + 70 + (k % 2 ? 0.55 : 0.2) * (DISC_OUT - DISC_IN) + (rr() - 0.5) * 60;
    c.radius = 24 + 10 * Math.sqrt(c.notes.length);
    c.center = { x: Math.cos(c.ang) * c.rMid, y: 0, z: Math.sin(c.ang) * c.rMid };
    c.ideas = c.notes.reduce((s, n) => s + Math.max(1, n.headings), 0);
    c.hue = (0.58 + k * 0.618034) % 1; // golden-ratio hues: neighbours never look alike
  });

  for (const c of list) {
    for (const n of c.notes) {
      const r = rng(hashStr(n.id));
      const rad = clamp(c.rMid + gauss(r) * c.radius * 0.75, DISC_IN, DISC_OUT + 40);
      const ang = c.ang + gauss(r) * Math.min(c.span * 0.3, (c.radius * 0.8) / c.rMid);
      n.pos = { x: Math.cos(ang) * rad, y: gauss(r) * 10, z: Math.sin(ang) * rad };
      n.seed = r();
    }
    relax(c.notes, MIN_DIST, RELAX_PASSES);
  }

  notes.forEach((n, i) => {
    n.index = i;
    n.deg = new Set([...n.out, ...n.inn]).size;
    n.size = Math.min(16, 6 + 1.9 * Math.sqrt(n.deg) + 0.5 * Math.log(1 + n.words / 60));
  });
  return { notes, consts: list, edges, lookup, resolve };
}

/**
 * Pushes apart points closer than d. Uses a uniform hash grid with cell = d, so each pass
 * only compares neighbouring cells: O(n) per pass instead of O(n²), no allocations per pair.
 */
export function relax(items, d, passes) {
  const n = items.length;
  if (n < 2) return;
  const d2 = d * d;
  const grid = new Map();
  const cellOf = (p) => Math.floor(p.x / d) * 73856093 ^ Math.floor(p.z / d) * 19349663;
  for (let it = 0; it < passes; it++) {
    grid.clear();
    for (let i = 0; i < n; i++) {
      const k = cellOf(items[i].pos);
      const b = grid.get(k);
      if (b) b.push(i); else grid.set(k, [i]);
    }
    let moved = false;
    for (let i = 0; i < n; i++) {
      const A = items[i].pos;
      const cx = Math.floor(A.x / d), cz = Math.floor(A.z / d);
      for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gz = cz - 1; gz <= cz + 1; gz++) {
        const b = grid.get(gx * 73856093 ^ gz * 19349663);
        if (!b) continue;
        for (const j of b) {
          if (j <= i) continue;
          const B = items[j].pos;
          let dx = A.x - B.x, dy = A.y - B.y, dz = A.z - B.z;
          const L2 = dx * dx + dy * dy + dz * dz;
          if (L2 >= d2) continue;
          let L = Math.sqrt(L2);
          if (L < 1e-3) { dx = ((i * 7919) % 13) / 13 - 0.5 || 0.3; dz = ((j * 104729) % 11) / 11 - 0.5 || -0.3; dy = 0; L = Math.hypot(dx, dz); }
          const k = ((d - Math.min(L, Math.sqrt(L2) || L)) / L) * 0.5;
          A.x += dx * k; A.y += dy * k; A.z += dz * k;
          B.x -= dx * k; B.y -= dy * k; B.z -= dz * k;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
}

/** Notes within `depth` links of n (undirected). depth = Infinity → whole connected component. */
export function neighbourhood(n, depth) {
  const seen = new Set([n]);
  let frontier = [n];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next = [];
    for (const x of frontier) for (const y of [...x.out, ...x.inn]) if (!seen.has(y)) { seen.add(y); next.push(y); }
    frontier = next;
  }
  return seen;
}

/** Search: every word must appear; title matches rank highest. "#tag words" filters by tag (incl. sub-tags). */
export function search(notes, query, limit = 40) {
  let s = norm(query.trim());
  if (!s) return { hits: [], words: [] };
  let tagF = null;
  const tm = /^#(\S+)\s*(.*)$/.exec(s);
  if (tm) { tagF = tm[1]; s = tm[2]; }
  const words = s.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const n of notes) {
    if (tagF && !n.tags.some((t) => { const x = norm(t); return x === tagF || x.startsWith(tagF + '/'); })) continue;
    let total = words.length ? 0 : 1;
    for (const w of words) {
      const sc = (n._title.startsWith(w) ? 5 : n._title.includes(w) ? 3 : 0) + (n._names.includes(w) ? 2 : 0) + (n._tags.includes(w) ? 1.5 : 0) + (n._body.includes(w) ? 1 : 0);
      if (!sc) { total = 0; break; }
      total += sc;
    }
    if (total > 0) scored.push([n, total]);
  }
  scored.sort((a, b) => b[1] - a[1] || b[0].mtime - a[0].mtime);
  return { all: scored.map((x) => x[0]), hits: scored.slice(0, limit).map((x) => x[0]), words };
}
