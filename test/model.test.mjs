import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, relax, neighbourhood, search, ROOT } from '../src/model.mjs';
import { computeStats, renderHomeHtml, renderStatsHtml, noteInsights } from '../src/stats.mjs';
import { setLang, t } from '../src/i18n.mjs';

const DAY = 86400000;
const now = Date.UTC(2026, 10, 22, 12);
const note = (rel, o = {}) => ({
  rel, name: rel.split('/').pop().replace(/\.md$/, ''), title: o.title || rel.split('/').pop().replace(/\.md$/, ''),
  folder: rel.includes('/') ? rel.split('/')[0] : '', tags: o.tags || [], aliases: o.aliases || [], links: o.links || [],
  words: o.words ?? 100, headings: o.headings ?? 1, text: o.text || '', tasksOpen: o.tasksOpen || 0, tasksDone: o.tasksDone || 0,
  ctime: o.ctime ?? now - 10 * DAY, mtime: o.mtime ?? now - 2 * DAY, created: o.created ?? null,
});
const vault = (notes, path = '/v') => ({ name: 'V', path, notes });

test('link resolution: real names beat aliases; paths; self links ignored', () => {
  const M = buildModel([vault([
    note('A.md', { aliases: ['B'], links: ['B', 'A'] }),
    note('Sub/B.md', { links: ['Sub/C'] }),
    note('Sub/C.md', { links: ['missing'] }),
  ])]);
  const [A, B, C] = ['A', 'B', 'C'].map((n) => M.notes.find((x) => x.name === n));
  assert.ok(A.out.has(B), '[[B]] resolves to the real note B, not the alias on A');
  assert.ok(!A.out.has(A), 'self link ignored');
  assert.ok(B.out.has(C), 'path links resolve');
  assert.equal(M.edges.length, 2);
  assert.equal(M.resolve(0, 'missing'), null);
});

test('a folder literally named like the root key does not merge with the root', () => {
  const M = buildModel([vault([note('x.md'), note('Raíz/y.md'), note('root/z.md')])]);
  assert.equal(M.consts.length, 3);
  assert.ok(M.consts.some((c) => c.name === ROOT));
});

test('group by tag puts untagged notes in their own group', () => {
  const M = buildModel([vault([note('a.md', { tags: ['x/y'] }), note('b.md')])], { groupBy: 'tag', untaggedLabel: 'untagged' });
  assert.deepEqual(M.consts.map((c) => c.label).sort(), ['#x', 'untagged']);
});

test('layout is deterministic and respects the minimum distance', () => {
  const notes = Array.from({ length: 400 }, (_, i) => note(`F/n${i}.md`));
  const a = buildModel([vault(notes)]), b = buildModel([vault(notes)]);
  assert.deepEqual(a.notes[7].pos, b.notes[7].pos);
  let tooClose = 0;
  for (let i = 0; i < a.notes.length; i++) for (let j = i + 1; j < a.notes.length; j++) {
    const p = a.notes[i].pos, q = a.notes[j].pos;
    if (Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) < 12) tooClose++;
  }
  assert.ok(tooClose < a.notes.length * 0.02, `${tooClose} pairs too close`);
});

test('relax is fast for one huge group (was 14 s at 5k)', () => {
  const items = Array.from({ length: 20000 }, (_, i) => ({ pos: { x: (i % 140) * 3, y: 0, z: Math.floor(i / 140) * 3 } }));
  const t0 = Date.now();
  relax(items, 18, 12);
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
});

test('neighbourhood depth', () => {
  const M = buildModel([vault([note('a.md', { links: ['b'] }), note('b.md', { links: ['c'] }), note('c.md', { links: ['d'] }), note('d.md')])]);
  const a = M.notes.find((n) => n.name === 'a');
  assert.equal(neighbourhood(a, 1).size, 2);
  assert.equal(neighbourhood(a, 2).size, 3);
  assert.equal(neighbourhood(a, Infinity).size, 4);
});

test('search: all words must match, accents ignored, #tag filter', () => {
  const M = buildModel([vault([
    note('Café.md', { title: 'Café con leche', text: 'receta', tags: ['comida/bebidas'] }),
    note('Te.md', { title: 'Té verde', text: 'receta china', tags: ['comida'] }),
  ])]);
  assert.deepEqual(search(M.notes, 'cafe').hits.map((n) => n.name), ['Café']);
  assert.deepEqual(search(M.notes, 'receta china').hits.map((n) => n.name), ['Te']);
  assert.equal(search(M.notes, '#comida').all.length, 2, 'sub-tags match their parent');
  assert.equal(search(M.notes, '#comida/bebidas').all.length, 1);
  assert.equal(search(M.notes, '#comida verde').all.length, 1);
});

test('stats: network, broken links, orphans, tasks, review', () => {
  const M = buildModel([vault([
    note('Hub.md', { links: ['A', 'B', 'Ghost'], tasksOpen: 2, tasksDone: 1, mtime: now - 60 * DAY }),
    note('X/A.md', { links: ['Ghost'], words: 10 }),
    note('Y/B.md', { words: 10 }),
    note('Lonely.md'),
  ])]);
  const s = computeStats(M, now);
  assert.equal(s.N, 4);
  assert.equal(s.network.orphans, 1);
  assert.equal(s.broken.total, 2);
  assert.equal(s.broken.distinct, 1);
  assert.equal(s.broken.missing[0].refs, 2);
  assert.equal(s.tasks.open, 2);
  assert.equal(s.tasks.forgotten, 1);
  assert.equal(s.growth.points.at(-1).notes, 4, 'growth curve ends at N');
  assert.equal(s.length.hist.reduce((a, b) => a + b, 0), 4, 'histogram sums to N');
  assert.ok(s.review.length > 0);
  const hub = M.notes.find((n) => n.name === 'Hub');
  assert.ok(noteInsights(hub, s).length > 0);
});

test('stats HTML renders in both languages with no undefined/NaN', () => {
  const notes = Array.from({ length: 200 }, (_, i) => note(`G${i % 6}/n${i}.md`, {
    links: [`n${(i * 7) % 200}`, i % 9 ? `n${(i + 1) % 200}` : 'nope'], tags: i % 3 ? [`t${i % 5}`, `t${i % 5}/s`] : [],
    mtime: now - (i % 120) * DAY, ctime: now - (i % 300) * DAY, words: (i * 37) % 3000, tasksOpen: i % 7 === 0 ? 1 : 0,
  }));
  const M = buildModel([vault(notes)]);
  for (const c of M.consts) c.css = '#abc';
  const s = computeStats(M, now);
  for (const lang of ['en', 'es']) {
    setLang(lang);
    const html = renderHomeHtml(s) + renderStatsHtml(s);
    assert.ok(!/undefined|NaN/.test(html), `bad value in ${lang} HTML`);
    assert.ok(html.length > 5000);
  }
  setLang('es');
  assert.equal(t('Pages'), 'Páginas');
  setLang('en');
});

test('stats on an empty vault and on a copied vault', () => {
  const empty = computeStats(buildModel([vault([])]), now);
  assert.equal(empty.N, 0);
  assert.ok(renderHomeHtml(empty).includes('muted'));
  // 100 notes all "born" today but edited long ago → dates flagged as unreliable.
  const copied = Array.from({ length: 100 }, (_, i) => note(`n${i}.md`, { ctime: now, mtime: now - (50 + i) * DAY }));
  const s = computeStats(buildModel([vault(copied)]), now);
  assert.equal(s.datesSuspect, true);
  assert.ok(s.growth.new30 < 100, 'copied notes are not counted as new');
});

test('stats scale: 10k notes in well under a second', () => {
  const notes = Array.from({ length: 10000 }, (_, i) => note(`F${i % 40}/n${i}.md`, { links: [`n${(i * 13) % 10000}`], tags: [`t${i % 30}`] }));
  const M = buildModel([vault(notes)]);
  const t0 = Date.now();
  computeStats(M, now);
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});
