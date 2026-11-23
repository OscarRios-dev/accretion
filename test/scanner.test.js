// Run with: npm test   (Node's built-in test runner, no dependencies)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseNote, scanVault, makeIgnore } = require('../scanner');

test('frontmatter: inline, block and comma lists; BOM; CRLF', () => {
  assert.deepEqual(parseNote('---\ntags: [a, b]\n---\n').tags.sort(), ['a', 'b']);
  assert.deepEqual(parseNote('---\ntags:\n  - x\n  - y/z\n---\n').tags.sort(), ['x', 'y/z']);
  assert.deepEqual(parseNote('---\ntags: one two\n---\n').tags.sort(), ['one', 'two']);
  assert.deepEqual(parseNote('﻿---\r\ntags: [bom]\r\n---\r\nbody').tags, ['bom']);
  assert.deepEqual(parseNote('---\nTags: [Case]   # comment\n---\n').tags, ['case']);
  assert.deepEqual(parseNote('---\n---\nhello').tags, []);
});

test('aliases: spaces and quoted commas stay one alias', () => {
  assert.deepEqual(parseNote('---\naliases: Mi Alias Largo\n---\n').aliases, ['Mi Alias Largo']);
  assert.deepEqual(parseNote('---\naliases: ["Hola, mundo", otro]\n---\n').aliases, ['Hola, mundo', 'otro']);
});

test('inline tags', () => {
  const t = parseNote('Text #a/b-c_d and #año and #cafe and #123 and #🚀cohete\n# Heading\nurl http://x.com/#frag').tags.sort();
  assert.ok(t.includes('a/b-c_d'));
  assert.ok(t.includes('año'));
  assert.ok(t.includes('cafe'), 'real words that look like hex are tags');
  assert.ok(t.includes('🚀cohete'));
  assert.ok(!t.includes('123'), 'purely numeric is not a tag');
  assert.ok(!t.includes('heading'));
  assert.ok(!t.includes('frag'));
});

test('code, comments and fences are ignored', () => {
  const n = parseNote([
    '```', '#nottag [[NotLink]]', '# Not title', '```',
    '~~~', '#nottag2', '~~~',
    'inline `#nottag3 [[NotLink2]]`',
    '%% #nottag4 [[NotLink3]] %%',
    '<!-- #nottag5 -->',
    '',
    '    #indented [[NotLink4]]',
    '',
    '#real [[Real]]',
  ].join('\n'));
  assert.deepEqual(n.tags, ['real']);
  assert.deepEqual(n.links, ['Real']);
  assert.equal(n.title, null);
});

test('list continuation lines are not treated as code', () => {
  const n = parseNote('- item\n\n    continued [[Kept]]\n');
  assert.deepEqual(n.links, ['Kept']);
});

test('wikilinks: alias, heading, block, embeds, escaped pipe, md links', () => {
  const n = parseNote('[[A]] [[B|b]] [[C#h]] [[D^blk]] ![[img.png]] ![[E]] | [[F\\|f]] | [[#local]] [x](G%20H.md) [y](<./I.md>)');
  assert.deepEqual(n.links.sort(), ['A', 'B', 'C', 'D', 'E', 'F', 'G H', 'I']);
  assert.equal(n.embeds, 1);
});

test('hostile input stays fast (no catastrophic backtracking)', () => {
  const evil = '[['.repeat(200000) + '#'.repeat(50000) + '%%'.repeat(1) + '<!--';
  const t0 = Date.now();
  parseNote(evil);
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
});

test('titles: frontmatter title > H1 > null; created date', () => {
  assert.equal(parseNote('---\ntitle: "From FM"\n---\n# H1').title, 'From FM');
  assert.equal(parseNote('# The **H1**\ntext').title, 'The H1');
  assert.equal(parseNote('---\ncreated: 2024-03-05\n---\n').created, Date.parse('2024-03-05'));
  assert.equal(parseNote('---\ndate: not a date\n---\n').created, null);
});

test('tasks and words', () => {
  const n = parseNote('- [ ] a\n- [x] b\n* [X] c\nuno dos tres');
  assert.equal(n.tasksOpen, 1);
  assert.equal(n.tasksDone, 2);
  assert.ok(n.words >= 3);
});

test('ignore patterns', () => {
  const ig = makeIgnore(['Templates', '95-Privado/', '*.excalidraw.md', 'Archive/**']);
  assert.ok(ig('Templates'));
  assert.ok(ig('Templates/a.md'));
  assert.ok(ig('Areas/Templates/a.md'));
  assert.ok(ig('95-Privado/secret.md'));
  assert.ok(ig('x/drawing.excalidraw.md'));
  assert.ok(ig('Archive/2020/x.md'));
  assert.ok(!ig('Notes/a.md'));
});

test('scanVault: many files, no drops, attachments, ignore, incremental cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accretion-test-'));
  try {
    const N = 3000;
    for (let i = 0; i < N; i++) {
      const sub = path.join(dir, 'F' + (i % 7));
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, `n${i}.md`), `# Note ${i}\n[[n${(i + 1) % N}]] #t${i % 5}`);
    }
    fs.mkdirSync(path.join(dir, 'Private'));
    fs.writeFileSync(path.join(dir, 'Private', 'secret.md'), 'hidden');
    fs.writeFileSync(path.join(dir, 'F0', 'pic.PNG'), '');
    fs.mkdirSync(path.join(dir, '.obsidian'));
    fs.writeFileSync(path.join(dir, '.obsidian', 'x.md'), 'nope');

    const cache = new Map();
    const r = await scanVault(dir, { ignore: ['Private'], cache });
    assert.equal(r.notes.length, N, 'every note is read');
    assert.equal(r.errors.length, 0);
    assert.ok(!r.notes.some((n) => n.rel.startsWith('Private')));
    assert.equal(r.attachments['pic.png'], 'F0/pic.PNG');
    assert.equal(r.notes.find((n) => n.rel === 'F0/n0.md').folder, 'F0');

    // Second scan reuses the cache; a changed file is re-parsed.
    fs.writeFileSync(path.join(dir, 'F0', 'n0.md'), '# Changed\n#newtag');
    const r2 = await scanVault(dir, { ignore: ['Private'], cache });
    const n0 = r2.notes.find((n) => n.rel === 'F0/n0.md');
    assert.equal(n0.title, 'Changed');
    assert.deepEqual(n0.tags, ['newtag']);
    assert.equal(cache.size, N);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
