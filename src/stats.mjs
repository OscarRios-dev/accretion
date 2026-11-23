// Statistics for Accretion. Pure functions, no dependencies, unit-tested.
//   computeStats(model, now?)          -> plain data (O(n log n + edges))
//   renderHomeHtml(stats, extras?)     -> "Home" dashboard
//   renderStatsHtml(stats)             -> full "Statistics" page
//   noteInsights(note, stats)          -> short highlights for the note panel
// Clickable elements use data-id (note), data-c (group), data-q (search) and data-mode (switch tab).
// To add a statistic: compute it in computeStats, render it in renderStatsHtml, add strings to locales/es.mjs.
import { t, tn, fmt, fmt1, ago, fdate } from './i18n.mjs';
import { DAY, WEEK, norm, esc, pct, quantile } from './util.mjs';

const midnight = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const DAILY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ATTACH_RE = /\.(?!md$)[a-z0-9]{2,5}$/i; // link target with a non-.md extension: an attachment, not a note
const dowNames = () => [t('Mondays'), t('Tuesdays'), t('Wednesdays'), t('Thursdays'), t('Fridays'), t('Saturdays'), t('Sundays')];
const dowShort = () => t('M T W T F S S').split(' ');
function dailyDate(name) {
  const m = DAILY_RE.exec(name || '');
  if (!m) return null;
  const ms = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  return Number.isFinite(ms) ? ms : null;
}
function bucketize(values, edges) { // edges: ascending lower bounds
  const out = new Array(edges.length).fill(0);
  for (const v of values) { let k = edges.length - 1; while (k > 0 && v < edges[k]) k--; out[k]++; }
  return out;
}
const top = (arr, k, by) => arr.slice().sort(by).slice(0, k);

// ───────────────────────── computation ─────────────────────────
export function computeStats(model, now = Date.now()) {
  const notes = model.notes || [];
  const consts = model.consts || [];
  const edges = model.edges || [];
  const N = notes.length;
  const idx = new Map(notes.map((n, i) => [n, i]));
  const today = midnight(now);
  const dayOf = (ms) => Math.round((midnight(ms) - today) / DAY); // 0 = today, -1 = yesterday…

  // ── date reliability ──
  // birthtime resets on copy/clone/sync: then ctime > mtime for many notes, or most of the vault
  // is "born" the same day. A note is never created after its last edit, so the best estimate is
  // the earliest known date (frontmatter `created`, daily-note name, birthtime, mtime).
  let ctAfter = 0;
  const ctDays = new Map();
  for (const n of notes) {
    if (n.ctime > n.mtime + 60000) ctAfter++;
    const d = dayOf(n.ctime);
    ctDays.set(d, (ctDays.get(d) || 0) + 1);
  }
  let peak = 0;
  for (const v of ctDays.values()) if (v > peak) peak = v;
  const datesSuspect = N >= 20 && (ctAfter / N > 0.3 || peak / N > 0.5);
  const created = notes.map((n) => {
    let ms = Math.min(n.mtime, n.ctime || Infinity);
    const dd = dailyDate(n.name);
    if (dd != null && dd < ms) ms = dd;
    if (Number.isFinite(n.created) && n.created > 0 && n.created < ms) ms = n.created;
    return ms;
  });

  // ── daily activity (53-week map) ──
  // Each note contributes at most 3 events: creation, last edit and daily-note date.
  const dow0 = (new Date(today).getDay() + 6) % 7; // Monday = 0
  const HD = 53 * 7;
  const startOff = -(52 * 7 + dow0);
  const act = new Int32Array(HD);
  const punch = new Int32Array(7 * 24);
  notes.forEach((n, i) => {
    const offs = new Set([dayOf(created[i]), dayOf(n.mtime)]);
    const dd = dailyDate(n.name);
    if (dd != null) offs.add(dayOf(dd));
    for (const o of offs) { const k = o - startOff; if (o <= 0 && k >= 0 && k < HD) act[k]++; }
    const m = new Date(n.mtime);
    punch[((m.getDay() + 6) % 7) * 24 + m.getHours()]++;
  });
  const todayK = -startOff;
  const at = (off) => act[todayK + off] || 0;
  let cur = 0;
  for (let o = at(0) ? 0 : -1; todayK + o >= 0 && at(o) > 0; o--) cur++; // an empty today doesn't break the streak
  let best = 0, run = 0, bestEnd = 0;
  for (let k = 0; k <= todayK; k++) { run = act[k] ? run + 1 : 0; if (run > best) { best = run; bestEnd = k; } }
  const last30 = Array.from({ length: 30 }, (_, k) => at(k - 29));
  const last14 = last30.slice(-14);
  const active30 = last30.filter(Boolean).length;
  const nz = [...act.slice(0, todayK + 1)].filter(Boolean).sort((a, b) => a - b);
  const th = [quantile(nz, 0.25), quantile(nz, 0.5), quantile(nz, 0.75)];
  const level = (v) => (!v ? 0 : v <= th[0] ? 1 : v <= th[1] ? 2 : v <= th[2] ? 3 : 4);
  const heatCells = Array.from({ length: HD }, (_, k) => {
    const off = k + startOff;
    return { t: today + off * DAY, v: act[k], lvl: level(act[k]), future: off > 0 };
  });
  const months = [];
  for (let col = 0; col < 53; col++) {
    for (let r = 0; r < 7; r++) {
      const ms = today + (startOff + col * 7 + r) * DAY;
      if (new Date(ms).getDate() === 1 && col < 51) { months.push({ col, t: ms }); break; }
    }
  }
  const activeYear = nz.length;
  let pk = 0;
  for (let k = 1; k < punch.length; k++) if (punch[k] > punch[pk]) pk = k;
  const pmax = punch[pk] || 1;
  const punchLvl = [...punch].map((v) => (!v ? 0 : Math.min(4, 1 + Math.floor((v / pmax) * 3.999))));
  // Is the last-30-days chart dominated by a single day (e.g. a vault imported at once)?
  const max30 = Math.max(0, ...last30), sum30 = last30.reduce((a, b) => a + b, 0);
  const spike30 = sum30 >= 10 && max30 / sum30 > 0.7 ? { v: max30, day: today - (29 - last30.indexOf(max30)) * DAY } : null;

  // ── growth ──
  const order = created.map((ms, i) => [ms, notes[i].words || 0]).sort((a, b) => a[0] - b[0]);
  const first = order.length ? order[0][0] : now;
  const W = Math.min(104, Math.max(8, Math.ceil((now - first) / WEEK) + 1));
  const growth = [];
  let p = 0, cn = 0, cw = 0;
  for (let k = 0; k < W; k++) {
    const end = today + DAY - (W - 1 - k) * WEEK;
    while (p < order.length && order[p][0] < end) { cn++; cw += order[p][1]; p++; }
    growth.push({ t: end - DAY, notes: cn, words: cw });
  }
  const newIn = (days) => created.filter((ms) => ms > now - days * DAY).length;
  const newPerWeek12 = new Array(12).fill(0);
  for (const ms of created) { const k = Math.floor((today + DAY - ms) / WEEK); if (k >= 0 && k < 12) newPerWeek12[11 - k]++; }

  // ── network ──
  const nb = notes.map((n) => { const s = new Set(n.out); n.inn.forEach((x) => s.add(x)); s.delete(n); return s; });
  const degs = nb.map((s) => s.size);
  const degSorted = degs.slice().sort((a, b) => a - b);
  const orphans = [], deadEnds = [];
  notes.forEach((n, i) => { if (!degs[i]) orphans.push(n); else if (!n.out.size && n.inn.size) deadEnds.push(n); });
  const par = Int32Array.from({ length: N }, (_, i) => i);
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  let cross = 0;
  const gInt = new Map(), gExt = new Map();
  for (const [a, b] of edges) {
    const ia = idx.get(a), ib = idx.get(b);
    if (ia == null || ib == null) continue;
    const ra = find(ia), rb = find(ib);
    if (ra !== rb) par[ra] = rb;
    if (a.c === b.c) gInt.set(a.c, (gInt.get(a.c) || 0) + 1);
    else { cross++; gExt.set(a.c, (gExt.get(a.c) || 0) + 1); gExt.set(b.c, (gExt.get(b.c) || 0) + 1); }
  }
  const compSize = new Map();
  for (let i = 0; i < N; i++) if (degs[i]) { const r = find(i); compSize.set(r, (compSize.get(r) || 0) + 1); }
  const comps = [...compSize.values()].sort((a, b) => b - a);
  const giant = comps[0] || 0;
  const islands = Math.max(0, comps.length - 1);
  // Bridges: notes whose neighbours sit in many different groups (cheap stand-in for betweenness).
  const bridgeScore = notes.map((n, i) => { const g = new Set(); nb[i].forEach((x) => { if (x.c !== n.c) g.add(x.c); }); return g.size; });
  const hubs = top(notes.map((n, i) => ({ n, v: degs[i] })).filter((x) => x.v > 0), 6, (a, b) => b.v - a.v);
  const bridges = top(notes.map((n, i) => ({ n, v: bridgeScore[i], d: degs[i] })).filter((x) => x.v >= 2), 6, (a, b) => b.v - a.v || b.d - a.d);

  // ── broken links (notes that are linked but don't exist yet) ──
  const resolve = model.resolve || (() => null);
  const missing = new Map();
  const brokenBy = new Int32Array(N);
  let broken = 0, totalLinks = 0;
  notes.forEach((n, i) => {
    for (const l of n.links || []) {
      totalLinks++;
      if (resolve(n.vault, l)) continue;
      const k = norm(l.replace(/\.md$/i, ''));
      if (ATTACH_RE.test(k)) continue;
      broken++; brokenBy[i]++;
      const key = (n.vault ?? 0) + '|' + k;
      let e = missing.get(key);
      if (!e) missing.set(key, (e = { label: l.split('/').pop(), refs: 0 }));
      e.refs++;
    }
  });
  const missingTop = top([...missing.values()], 8, (a, b) => b.refs - a.refs || a.label.localeCompare(b.label));
  const brokenNotes = brokenBy.reduce((a, v) => a + (v ? 1 : 0), 0);

  // ── tags ──
  const tagCount = new Map(), rootCount = new Map(), rootSubs = new Map(), pair = new Map();
  let tagged = 0;
  for (const n of notes) {
    const ts = [...new Set(n.tags || [])].slice(0, 12).sort();
    if (ts.length) tagged++;
    const roots = new Set();
    for (const tg of ts) {
      tagCount.set(tg, (tagCount.get(tg) || 0) + 1);
      const r = tg.split('/')[0];
      roots.add(r);
      if (tg.includes('/')) { let s = rootSubs.get(r); if (!s) rootSubs.set(r, (s = new Set())); s.add(tg); }
    }
    roots.forEach((r) => rootCount.set(r, (rootCount.get(r) || 0) + 1));
    for (let a = 0; a < ts.length; a++) for (let b = a + 1; b < ts.length; b++) {
      if (ts[b].startsWith(ts[a] + '/')) continue; // parent/child isn't co-occurrence
      const k = ts[a] + '\u0000' + ts[b];
      pair.set(k, (pair.get(k) || 0) + 1);
    }
  }
  const tagsTop = top([...rootCount], 8, (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tg, v]) => ({ t: tg, v, subs: rootSubs.get(tg)?.size || 0 }));
  const allTags = top([...tagCount], 60, (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tg, v]) => ({ t: tg, v }));
  const pairsTop = top([...pair].filter(([, v]) => v >= 2), 6, (a, b) => b[1] - a[1]).map(([k, v]) => {
    const [a, b] = k.split('\u0000');
    return { a, b, v };
  });

  // ── length ──
  const words = notes.map((n) => n.words || 0);
  const wSorted = words.slice().sort((a, b) => a - b);
  const totalWords = words.reduce((a, b) => a + b, 0);
  const LEN_EDGES = [0, 1, 50, 200, 500, 1000, 2500];
  const lenHist = bucketize(words, LEN_EDGES);
  const stubs = words.filter((w) => w > 0 && w < 50).length;
  const longest = top(notes, 4, (a, b) => b.words - a.words);
  const DEG_EDGES = [0, 1, 2, 3, 5, 9, 17];
  const degHist = bucketize(degs, DEG_EDGES);

  // ── freshness ──
  const ageD = notes.map((n) => (now - n.mtime) / DAY);
  const FRESH_DAYS = [7, 30, 90, 365, Infinity];
  const fresh = FRESH_DAYS.map(() => 0);
  for (const a of ageD) fresh[FRESH_DAYS.findIndex((d) => a < d)]++;
  const stale90 = ageD.filter((a) => a >= 90).length;

  // ── tasks ──
  let tOpen = 0, tDone = 0, forgotten = 0;
  for (const n of notes) {
    tOpen += n.tasksOpen || 0; tDone += n.tasksDone || 0;
    if (n.tasksOpen && now - n.mtime > 30 * DAY) forgotten++;
  }

  // ── groups ──
  const groups = consts.map((c) => {
    let w = 0, linked = 0, st = 0, op = 0, dn = 0, last = 0;
    for (const n of c.notes) {
      const i = idx.get(n);
      w += n.words || 0;
      if (degs[i]) linked++;
      if (ageD[i] >= 90) st++;
      op += n.tasksOpen || 0; dn += n.tasksDone || 0;
      if (n.mtime > last) last = n.mtime;
    }
    const inner = gInt.get(c) || 0, outer = gExt.get(c) || 0;
    return { c, notes: c.notes.length, words: w, linkedPct: pct(linked, c.notes.length), inner, outer,
      cohesion: inner + outer ? pct(inner, inner + outer) : 0, stalePct: pct(st, c.notes.length), open: op, done: dn, last };
  }).sort((a, b) => b.notes - a.notes || b.words - a.words);

  // ── to review ── four reasons, interleaved so the list is varied; each note appears once.
  const p80 = quantile(degSorted, 0.8);
  const reasons = [
    { label: 'Cited stub', c: 'var(--orange)',
      list: notes.map((n, i) => ({ n, i })).filter(({ n }) => n.words < 80 && n.inn.size >= 2).sort((a, b) => b.n.inn.size - a.n.inn.size),
      why: ({ n }) => `${tn(n.inn.size, '{n} note cites it', '{n} notes cite it')} · ${tn(n.words, '{n} word', '{n} words')}` },
    { label: 'Key but forgotten', c: 'var(--purple)',
      list: notes.map((n, i) => ({ n, i })).filter(({ i }) => degs[i] >= Math.max(3, p80) && ageD[i] >= 180).sort((a, b) => degs[b.i] * Math.log(ageD[b.i]) - degs[a.i] * Math.log(ageD[a.i])),
      why: ({ n, i }) => `${tn(degs[i], '{n} neighbour', '{n} neighbours')} · ${t('edited {when}', { when: ago(n.mtime, now) })}` },
    { label: 'Orphan', c: 'var(--blue)',
      list: orphans.map((n) => ({ n, i: idx.get(n) })).sort((a, b) => created[b.i] - created[a.i] || b.n.words - a.n.words),
      why: ({ i }) => `${t('no links')} · ${t('created {when}', { when: ago(created[i], now) })}` },
    { label: 'Forgotten tasks', c: 'var(--green)',
      list: notes.map((n, i) => ({ n, i })).filter(({ n }) => n.tasksOpen && now - n.mtime > 30 * DAY).sort((a, b) => b.n.tasksOpen - a.n.tasksOpen),
      why: ({ n }) => `${tn(n.tasksOpen, '{n} open task', '{n} open tasks')} · ${t('edited {when}', { when: ago(n.mtime, now) })}` },
  ];
  const review = [], used = new Set();
  const REVIEW_MAX = 12;
  for (let round = 0; review.length < REVIEW_MAX && round < REVIEW_MAX; round++) {
    for (const r of reasons) {
      const x = r.list.find((y) => !used.has(y.n));
      if (x && review.length < REVIEW_MAX) { used.add(x.n); review.push({ n: x.n, label: r.label, c: r.c, why: r.why(x) }); }
    }
  }
  const reviewTotal = new Set(reasons.flatMap((r) => r.list.map((x) => x.n))).size;

  const byNote = new Map();
  notes.forEach((n, i) => byNote.set(n, { i, deg: degs[i], bridges: bridgeScore[i], broken: brokenBy[i], ageDays: ageD[i], created: created[i] }));

  return {
    now, N, groupsN: consts.length, edgesN: edges.length, datesSuspect,
    activity: { cells: heatCells, months, last30, last14, active30, activeYear, streak: cur, best, spike30,
      bestEnd: today + (bestEnd + startOff) * DAY, punch: [...punch], punchLvl, peak: { dow: Math.floor(pk / 24), hour: pk % 24, v: punch[pk] } },
    growth: { points: growth, newPerWeek12, new30: newIn(30), new90: newIn(90), first },
    network: { linked: N - orphans.length, linkedPct: pct(N - orphans.length, N), avgDeg: N ? (2 * edges.length) / N : 0,
      orphans: orphans.length, orphanList: orphans, deadEnds: deadEnds.length, giant, giantPct: pct(giant, N), islands, cross, crossPct: pct(cross, edges.length),
      degHist, hubs, bridges },
    broken: { total: broken, notes: brokenNotes, totalLinks, pct: pct(broken, totalLinks), missing: missingTop, distinct: missing.size },
    tags: { tagged, coverage: pct(tagged, N), distinct: tagCount.size, top: tagsTop, all: allTags, pairs: pairsTop },
    length: { total: totalWords, median: Math.round(quantile(wSorted, 0.5)), p90: Math.round(quantile(wSorted, 0.9)), hist: lenHist, stubs, empty: lenHist[0], longest },
    fresh: { counts: fresh, stale90, stalePct: pct(stale90, N) },
    tasks: { open: tOpen, done: tDone, pct: pct(tDone, tOpen + tDone), forgotten },
    groups, review, reviewTotal,
    byNote, degSorted, medianWords: quantile(wSorted, 0.5), created,
  };
}

// ───────────────────────── HTML pieces ─────────────────────────
// Clickable rows get tabindex + role so keyboard users can reach them (Enter activates).
const act = (attrs) => (attrs ? `${attrs} tabindex="0" role="button"` : '');
function spark(arr, cap, hi = 1) { // hi: highlighted trailing bars (0 = none dimmed)
  const mx = Math.max(1, ...arr);
  const bars = arr.map((v, i) => `<i class="${v ? (hi && i < arr.length - hi ? 'lo' : '') : 'z'}" style="height:${v ? Math.max(8, (v / mx) * 100) : 0}%" title="${fmt(v)}"></i>`).join('');
  return `<div class="spark" aria-hidden="true">${bars}</div><div class="sl">${cap}</div>`;
}
const card = ({ c, n, l, s, b, arr, cap, hi }) =>
  `<div class="stat" style="--c:${c}"><div class="n">${n}</div><div class="l">${l}</div><div class="s">${s}</div>${b ? `<span class="b">${b}</span>` : ''}${arr ? spark(arr, cap, hi) : ''}</div>`;
const box = (c, title, sub, body, cls = '') => `<section class="box ${cls}" style="--c:${c}"><h3><i></i>${title}</h3><div class="sub">${sub}</div>${body}</section>`;
const empty = (msg) => `<p class="muted">${msg}</p>`;
const row = (attrs, label, value, frac) => `<div class="r${attrs ? '' : ' st'}" ${act(attrs)}><div class="t"><span>${label}</span><span>${value}</span></div><div class="track"><i style="width:${Math.max(0, Math.min(100, frac * 100)).toFixed(1)}%"></i></div></div>`;
const dId = (n) => `data-id="${esc(n.id)}"`;
const dC = (c) => `data-c="${esc(c.key)}"`;
const dQ = (q) => `data-q="${esc(q)}"`;
const notesN = (v) => tn(v, '{n} note', '{n} notes');

function barChart(a, startT) {
  if (a.spike30) {
    return `<p class="muted">${t('{n} notes on {day} — the rest of the month is quiet. This usually means the vault was imported or synced that day.', { n: fmt(a.spike30.v), day: fdate(a.spike30.day) })}</p>`;
  }
  const values = a.last30;
  const mx = Math.max(1, ...values);
  const ya = mx >= 2 ? [mx, Math.round(mx / 2), 0] : [mx, '', 0];
  const n = values.length;
  return `<div class="chart"><div class="ya">${ya.map((v) => `<span>${v === '' ? '' : fmt(v)}</span>`).join('')}</div>
    <div class="bars" role="img" aria-label="${t('Notes per day, last 30 days')}">${values.map((v, k) => `<i style="height:${(v / mx) * 100}%" title="${fdate(startT + k * DAY)}: ${notesN(v)}"></i>`).join('')}</div>
    <div class="xa"><span>${fdate(startT)}</span><span>${fdate(startT + Math.floor(n / 2) * DAY)}</span><span>${t('Today')}</span></div></div>`;
}

function heatmap(a) {
  const cells = a.cells.map((x) => `<i class="h${x.lvl}${x.future ? ' f' : ''}" title="${fdate(x.t, { weekday: 'short', day: 'numeric', month: 'short' })}: ${notesN(x.v)}"></i>`).join('');
  const months = a.months.map((m) => `<span style="grid-column:${m.col + 1} / span 4">${esc(fdate(m.t, { month: 'short' }))}</span>`).join('');
  const d = dowShort();
  return `<div class="heat" role="img" aria-label="${t('Activity map')}"><div class="hm">${months}</div><div class="hd"><span>${d[0]}</span><span></span><span>${d[2]}</span><span></span><span>${d[4]}</span><span></span><span></span></div><div class="hg">${cells}</div></div>
    <div class="legend">${t('Less')}<i class="h0"></i><i class="h1"></i><i class="h2"></i><i class="h3"></i><i class="h4"></i>${t('More')}</div>`;
}

function punchCard(a) {
  const d1 = dowShort(), dn = dowNames();
  let html = '';
  for (let d = 0; d < 7; d++) {
    html += `<span>${d1[d]}</span>`;
    for (let h = 0; h < 24; h++) { const v = a.punch[d * 24 + h]; html += `<i class="h${a.punchLvl[d * 24 + h]}" title="${dn[d]} ${h}:00 · ${notesN(v)}"></i>`; }
  }
  html += '<span></span>' + Array.from({ length: 24 }, (_, h) => `<b>${h % 6 ? '' : h + ' h'}</b>`).join('');
  return `<div class="punch" role="img" aria-label="${t('Weekly rhythm')}">${html}</div>`;
}

function areaChart(points, key) {
  const n = points.length;
  const mx = Math.max(1, ...points.map((p) => p[key]));
  const xy = points.map((p, k) => [(k / Math.max(1, n - 1)) * 300, 100 - (p[key] / mx) * 96]);
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  // Short ranges show days, long ranges show months.
  const fo = points[n - 1].t - points[0].t < 150 * DAY ? { day: 'numeric', month: 'short' } : { month: 'short', year: 'numeric' };
  return `<div class="chart"><div class="ya"><span>${fmt(mx)}</span><span>${fmt(mx / 2)}</span><span>0</span></div>
    <svg class="area" viewBox="0 0 300 100" preserveAspectRatio="none" role="img" aria-label="${t('Cumulative notes')}">
      <path d="M0,100 L${line.replace(/ /g, ' L')} L300,100 Z" fill="var(--c)" fill-opacity=".14"/>
      <polyline points="${line}" fill="none" stroke="var(--c)" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>
    <div class="xa"><span>${fdate(points[0].t, fo)}</span><span>${fdate(points[Math.floor((n - 1) / 2)].t, fo)}</span><span>${t('Today')}</span></div></div>`;
}

function histogram(counts, labels, total) {
  const mx = Math.max(1, ...counts);
  return counts.map((v, k) => row('', labels[k], `${fmt(v)} · ${pct(v, total)}%`, v / mx)).join('');
}

function freshBar(f, N) {
  const labels = [t('This week'), t('This month'), t('1–3 months'), t('3–12 months'), t('Over a year')];
  const op = [1, 0.72, 0.5, 0.3, 0.14];
  const segs = f.counts.map((v, k) => (v ? `<i style="flex:${v};opacity:${op[k]}" title="${labels[k]}: ${notesN(v)}"></i>` : '')).join('');
  const leg = f.counts.map((v, k) => `<span><i style="opacity:${op[k]}"></i>${labels[k]} <b>${pct(v, N)}%</b></span>`).join('');
  return `<div class="stack" aria-hidden="true">${segs}</div><div class="stack-l">${leg}</div>`;
}

function groupTable(groups, now) {
  const head = `<div class="tr th"><span>${t('Group')}</span><span>${t('Notes')}</span><span>${t('Words')}</span><span title="${t('Notes with at least one link')}">${t('Linked')}</span><span title="${t('Links that stay inside the group')}">${t('Cohesion')}</span><span title="${t('Not edited in 90+ days')}">${t('Dormant')}</span></div>`;
  const rows = groups.slice(0, 12).map((g) => `<div class="tr" ${act(dC(g.c))} title="${t('Last edit {when}', { when: ago(g.last, now) })}">
    <span><i class="dot" style="background:${g.c.css || 'var(--soft)'}"></i>${esc(g.c.label)}</span><span>${fmt(g.notes)}</span><span>${fmt(g.words)}</span>
    <span>${g.linkedPct}%</span><span>${g.inner + g.outer ? g.cohesion + '%' : '—'}</span><span>${g.stalePct}%</span></div>`).join('');
  const more = groups.length > 12 ? `<p class="muted">${tn(groups.length - 12, 'and {n} more group in Pages.', 'and {n} more groups in Pages.')}</p>` : '';
  return `<div class="tbl">${head}${rows}</div>${more}`;
}

function reviewList(s, k) {
  if (!s.review.length) return empty(t('Nothing urgent: no cited stubs, forgotten key notes, orphans or old tasks.'));
  const shown = s.review.slice(0, k);
  return shown.map((r) => `<div class="item" ${act(dId(r.n))}><b>${esc(r.n.title)}</b><span><em class="why" style="--c:${r.c}">${t(r.label)}</em>${esc(r.why)}</span></div>`).join('')
    + (s.reviewTotal > shown.length ? `<p class="muted">${tn(s.reviewTotal - shown.length, '{n} more candidate', '{n} more candidates')}${k < s.review.length ? ' ' + t('in Statistics') : ''}.</p>` : '');
}

const dateFlag = (s) => (s.datesSuspect ? `<p class="flag">${t('Creation dates look reset (copied or synced vault). The earliest known date of each note is used instead.')}</p>` : '');

// ───────────────────────── Home ─────────────────────────
export function renderHomeHtml(s, extras = {}) {
  if (!s.N) return empty(t('This vault has no notes yet. Create one in Obsidian and it will show up here as a star.'));
  const a = s.activity, nw = s.network, L = s.length;
  const cards = [
    card({ c: 'var(--accent)', n: fmt(s.N), l: t('Notes'), s: tn(s.groupsN, 'in {n} group', 'in {n} groups'), b: s.datesSuspect ? t('approx. dates') : t('+{n} in 30 days', { n: fmt(s.growth.new30) }), arr: s.growth.newPerWeek12, cap: t('New per week · 12 wk') }),
    card({ c: 'var(--accent)', n: `${nw.linkedPct}%`, l: t('Linked notes'), s: t('{n} neighbours on average', { n: fmt1(nw.avgDeg) }), b: nw.orphans ? tn(nw.orphans, '{n} orphan', '{n} orphans') : t('no orphans'), arr: nw.degHist, cap: t('Notes by neighbours: 0 → 17+'), hi: 0 }),
    card({ c: 'var(--accent)', n: fmt(L.total), l: t('Words'), s: t('median {n} per note', { n: fmt(L.median) }), b: L.stubs ? tn(L.stubs, '{n} stub', '{n} stubs') : '', arr: L.hist, cap: t('Notes by length: empty → 2,500+'), hi: 0 }),
    card({ c: 'var(--accent)', n: `${a.active30}`, l: t('Active days'), s: t('of the last 30'), b: tn(a.streak, 'streak {n} day', 'streak {n} days'), arr: a.last14, cap: t('Notes touched per day · 14 days') }),
  ].join('');
  const groups = s.groups.slice(0, 6);
  const gmax = Math.max(1, ...groups.map((g) => g.notes));
  const groupRows = groups.map((g) => row(dC(g.c), esc(g.c.label), t('{n} · {p}% linked', { n: fmt(g.notes), p: g.linkedPct }), g.notes / gmax)).join('')
    + (s.groups.length > 6 ? `<p class="muted">${tn(s.groups.length - 6, 'and {n} more group.', 'and {n} more groups.')}</p>` : '');
  const pins = extras.pinsHtml ? `<div class="box" style="margin-top:10px"><div class="cap">${t('Pinned')}</div>${extras.pinsHtml}</div>` : '';
  return `
    <div class="stats">${cards}</div>
    <div class="grid3">
      ${box('var(--accent)', t('Activity'), t('Notes created or last edited, per day'), barChart(a, s.now - 29 * DAY))}
      ${box('var(--orange)', t('To review'), t('Suggestions based on links, length and dates'), reviewList(s, 5))}
      ${box('var(--accent)', t('Groups'), t('Notes per group · click to fly there'), groupRows, 'rows')}
    </div>
    ${pins}
    <div class="grid2"><div class="box"><div class="cap">${t('Opened recently')}</div>${extras.recentHtml || empty(t('You haven’t opened any note from the map yet. Press <kbd>A</kbd> for a random one.'))}</div>
      <div class="box"><div class="cap">${t('Edited recently')}</div>${extras.editedHtml || empty(t('No edits recorded.'))}</div></div>
    <button class="btn ghost wide" data-mode="stats">${t('See all statistics')} →</button>`;
}

// ───────────────────────── Statistics ─────────────────────────
export function renderStatsHtml(s) {
  if (!s.N) return empty(t('This vault has no notes yet; statistics will appear once you write the first one.'));
  const a = s.activity, g = s.growth, nw = s.network, B = s.broken, T = s.tags, L = s.length, K = s.tasks;
  const last = g.points[g.points.length - 1];

  const kpis = [
    card({ c: 'var(--blue)', n: `${nw.giantPct}%`, l: t('In the main network'), s: nw.islands ? tn(nw.islands, '{n} separate island', '{n} separate islands') : t('everything connected in one block'), b: t('{p}% cross groups', { p: nw.crossPct }) }),
    card({ c: 'var(--orange)', n: fmt(B.total), l: t('Broken links'), s: B.total ? `${tn(B.notes, 'in {n} note', 'in {n} notes')} · ${t('{p}% of all', { p: B.pct })}` : t('all point to notes that exist'), b: B.distinct ? t('{n} to write', { n: fmt(B.distinct) }) : '' }),
    card({ c: 'var(--purple)', n: `${s.fresh.stalePct}%`, l: t('Dormant'), s: tn(s.fresh.stale90, '{n} note not edited in 90+ days', '{n} notes not edited in 90+ days') }),
    card({ c: 'var(--green)', n: K.open + K.done ? `${K.pct}%` : '—', l: t('Tasks done'), s: K.open + K.done ? t('{a} of {b}', { a: fmt(K.done), b: fmt(K.open + K.done) }) : t('no tasks in your notes'), b: K.forgotten ? t('{n} forgotten', { n: fmt(K.forgotten) }) : '' }),
  ].join('');

  const streakTxt = t('Current streak: <b>{a}</b> · Best streak: <b>{b}</b>', { a: tn(a.streak, '{n} day', '{n} days'), b: tn(a.best, '{n} day', '{n} days') })
    + (a.best ? ` (${t('until {d}', { d: fdate(a.bestEnd) })})` : '') + ' · ' + t('<b>{n}</b> active days this year', { n: fmt(a.activeYear) });
  const peakTxt = a.peak.v ? t('You usually finish editing on <b>{d}</b> around <b>{h}:00</b>.', { d: dowNames()[a.peak.dow], h: a.peak.hour }) : '';

  const network = [
    row('', t('Linked'), `${fmt(nw.linked)} · ${nw.linkedPct}%`, nw.linkedPct / 100),
    row(nw.orphans ? 'data-mode="orphans"' : '', t('Orphans (no links at all)'), `${fmt(nw.orphans)} · ${pct(nw.orphans, s.N)}%`, nw.orphans / s.N),
    row('', t('Dead ends (cited, link nowhere)'), `${fmt(nw.deadEnds)} · ${pct(nw.deadEnds, s.N)}%`, nw.deadEnds / s.N),
    row('', t('Main network'), `${fmt(nw.giant)} · ${nw.giantPct}%`, nw.giantPct / 100),
    row('', t('Links between groups'), `${fmt(nw.cross)} · ${nw.crossPct}%`, nw.crossPct / 100),
  ].join('');
  const hmax = Math.max(1, ...nw.hubs.map((x) => x.v));
  const hubs = nw.hubs.length ? nw.hubs.map((x) => row(dId(x.n), esc(x.n.title), fmt(x.v), x.v / hmax)).join('') : empty(t('No links between notes yet.'));
  const bmax = Math.max(1, ...nw.bridges.map((x) => x.v));
  const bridges = nw.bridges.length ? nw.bridges.map((x) => row(dId(x.n), esc(x.n.title), tn(x.v + 1, '{n} group', '{n} groups'), x.v / bmax)).join('') : empty(t('No note links to 2+ groups other than its own.'));

  const mmax = Math.max(1, ...B.missing.map((m) => m.refs));
  const missing = B.missing.length
    ? B.missing.map((m) => row(dQ(m.label), `[[${esc(m.label)}]]`, tn(m.refs, '{n} mention', '{n} mentions'), m.refs / mmax)).join('')
    : empty(t('No broken links: every [[link]] points to a note that exists.'));
  const tmax = Math.max(1, ...T.top.map((x) => x.v));
  const tags = T.top.length
    ? T.top.map((x) => row(dQ('#' + x.t), `#${esc(x.t)}${x.subs ? ` <small>+${x.subs} sub</small>` : ''}`, fmt(x.v), x.v / tmax)).join('')
    : empty(t('No note has tags yet.'));
  const pmax = Math.max(1, ...T.pairs.map((p) => p.v));
  const pairs = T.pairs.length
    ? T.pairs.map((p) => row(dQ('#' + p.a), `#${esc(p.a)} + #${esc(p.b)}`, t('{n} together', { n: fmt(p.v) }), p.v / pmax)).join('')
    : empty(t('No tags appear together in 2+ notes yet.'));

  const gtask = s.groups.filter((x) => x.open + x.done).sort((x, y) => y.open - x.open).slice(0, 6);
  const tasks = gtask.length
    ? gtask.map((x) => row(dC(x.c), esc(x.c.label), `${fmt(x.done)}/${fmt(x.open + x.done)} · ${pct(x.done, x.open + x.done)}%`, x.done / (x.open + x.done))).join('')
    : empty(t('No tasks (- [ ]) in your notes.'));
  const longest = L.longest.map((n) => `<div class="item" ${act(dId(n))}><b>${esc(n.title)}</b><span>${tn(n.words, '{n} word', '{n} words')} · ${esc(n.c.label)}</span></div>`).join('');
  const lenLabels = [t('Empty'), '1–49', '50–199', '200–499', '500–999', `${fmt(1000)}–${fmt(2499)}`, `${fmt(2500)}+`];

  return `
    ${dateFlag(s)}
    <div class="stats">${kpis}</div>
    <section class="box wide" style="--c:var(--accent)"><h3><i></i>${t('Activity map')}</h3><div class="sub">${t('Days with notes created or last edited · 12 months. Intermediate edits are not recorded, so this is a minimum.')}</div>
      ${heatmap(a)}<p class="kv">${streakTxt}</p></section>
    <div class="grid2">
      ${box('var(--accent)', t('Growth'), t('Cumulative notes by creation date · today {n} notes and {w} words', { n: fmt(last.notes), w: fmt(last.words) }), areaChart(g.points, 'notes'))}
      ${box('var(--accent)', t('Weekly rhythm'), t('Time of the last edit of each note'), punchCard(a) + (peakTxt ? `<p class="kv">${peakTxt}</p>` : ''))}
    </div>
    <div class="grid3">
      ${box('var(--blue)', t('Network health'), t('{n} neighbours per note on average', { n: fmt1(nw.avgDeg) }), network, 'rows')}
      ${box('var(--blue)', t('Central notes'), t('Most neighbours · click to open'), hubs, 'rows')}
      ${box('var(--blue)', t('Bridges'), t('Their neighbours span the most groups'), bridges, 'rows')}
    </div>
    <div class="grid3">
      ${box('var(--orange)', t('Notes to write'), t('Links to notes that don’t exist · click to see who cites them'), missing, 'rows')}
      ${box('var(--green)', t('Tags'), t('{p}% of notes have tags · {n} distinct', { p: T.coverage, n: fmt(T.distinct) }), tags, 'rows')}
      ${box('var(--green)', t('Tags that go together'), t('Pairs that share the most notes'), pairs, 'rows')}
    </div>
    <section class="box wide" style="--c:var(--accent)"><h3><i></i>${t('Groups')}</h3><div class="sub">${t('Comparison · click a row to fly to the group')}</div>${groupTable(s.groups, s.now)}</section>
    <div class="grid3">
      ${box('var(--accent)', t('Length'), t('Median {m} words · 10% exceed {p}', { m: fmt(L.median), p: fmt(L.p90) }), histogram(L.hist, lenLabels, s.N), 'rows')}
      ${box('var(--purple)', t('Freshness'), t('When each note was last edited'), freshBar(s.fresh, s.N) + `<div class="cap" style="margin-top:14px">${t('Longest')}</div>${longest}`)}
      ${box('var(--green)', t('Tasks by group'), K.open + K.done ? t('{o} open · {d} done', { o: fmt(K.open), d: fmt(K.done) }) : t('Checkboxes - [ ] in your notes'), tasks, 'rows')}
    </div>
    ${box('var(--orange)', t('To review'), t('Cited stubs, forgotten key notes, orphans and old tasks'), reviewList(s, 12), 'wide')}`;
}

// ───────────────────────── note panel ─────────────────────────
// Short highlights for the note panel. Only what stands out; nothing when the note is "normal".
export function noteInsights(n, s) {
  const x = s.byNote.get(n);
  if (!x) return [];
  const out = [];
  if (x.deg) {
    let lo = 0, hi = s.degSorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (s.degSorted[m] < x.deg) lo = m + 1; else hi = m; }
    const topPct = Math.max(1, Math.ceil(((s.degSorted.length - lo) / s.degSorted.length) * 100));
    if (topPct <= 10) out.push(t('Top {p}% by links', { p: topPct }));
  } else out.push(t('Orphan'));
  if (x.bridges >= 2) out.push(t('Bridge across {n} groups', { n: x.bridges + 1 }));
  if (x.broken) out.push(tn(x.broken, '{n} broken link', '{n} broken links'));
  if (s.medianWords > 0 && n.words >= 3 * s.medianWords) out.push(t('{x}× the median note', { x: fmt1(n.words / s.medianWords) }));
  if (x.ageDays >= 90) out.push(t('Not edited {when}', { when: ago(n.mtime, s.now) }));
  return out;
}
