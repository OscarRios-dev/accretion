// Lists every translatable string and reports the ones missing from src/locales/es.mjs.
// Run: npm run i18n:check
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const keys = new Set();
const STR = String.raw`'((?:[^'\\]|\\.)*)'`;
for (const f of ['src/renderer.js', 'src/stats.mjs', 'src/markdown.mjs', 'src/i18n.mjs']) {
  const s = read(f);
  for (const m of s.matchAll(new RegExp(String.raw`\bt\(\s*` + STR, 'g'))) keys.add(m[1]);
  for (const m of s.matchAll(new RegExp(String.raw`\btn\([^,]+,\s*` + STR + String.raw`,\s*` + STR, 'g'))) { keys.add(m[1]); keys.add(m[2]); }
  for (const m of s.matchAll(/label: '([^']+)'/g)) keys.add(m[1]);
  // strings passed to t() indirectly (error tables, fallbacks)
  for (const m of s.matchAll(/'(That path is not a folder\.|That folder has no[^']+|Couldn’t add that folder\.)'/g)) keys.add(m[1]);
}
for (const m of read('app/index.html').matchAll(/data-i18n(?:-title|-aria|-ph)?="([^"]+)"/g)) keys.add(m[1]);

const unescape = (k) => k.replace(/\\'/g, "'");
const all = [...keys].map(unescape).sort();
import(path.join(root, 'src/locales/es.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:')).then(({ default: es }) => {
  const missing = all.filter((k) => !(k in es));
  const unused = Object.keys(es).filter((k) => !all.includes(k));
  if (process.argv.includes('--list')) console.log(JSON.stringify(all, null, 1));
  console.log(`${all.length} strings · ${missing.length} missing in es · ${unused.length} unused in es`);
  if (missing.length) console.log('Missing:\n' + missing.map((k) => '  ' + JSON.stringify(k)).join('\n'));
  if (unused.length) console.log('Unused:\n' + unused.map((k) => '  ' + JSON.stringify(k)).join('\n'));
  process.exitCode = missing.length ? 1 : 0;
}).catch(() => {
  console.log(JSON.stringify(all, null, 1));
});
