// Tiny i18n: English strings are the keys; translations live in ./locales/*.mjs.
// t('Pages') -> 'Páginas' in Spanish. Missing translations fall back to English.
// tn(3, '{n} note', '{n} notes') picks the plural form and formats the number.
import ES from './locales/es.mjs';

const TABLES = { es: ES };
let lang = 'en';

export const LANGS = [['auto', 'Auto'], ['en', 'English'], ['es', 'Español']];
export function resolveLang(pref, nav = globalThis.navigator?.language || 'en') {
  if (pref === 'es' || pref === 'en') return pref;
  return String(nav).toLowerCase().startsWith('es') ? 'es' : 'en';
}
export function setLang(l) {
  lang = l === 'es' ? 'es' : 'en';
  if (globalThis.document) document.documentElement.lang = lang;
  nf = new Intl.NumberFormat(lang);
  rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
}
export const getLang = () => lang;

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m)) : s);
export function t(key, vars) {
  const tbl = TABLES[lang];
  return fill((tbl && tbl[key]) || key, vars);
}

let nf = new Intl.NumberFormat('en');
export const fmt = (x) => nf.format(Math.round(x));
export const fmt1 = (x) => new Intl.NumberFormat(lang, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(x);
export function tn(n, one, many, vars) {
  return t(n === 1 ? one : many, { n: fmt(n), ...vars });
}

let rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function ago(ms, now = Date.now()) {
  const s = (ms - now) / 1000;
  for (const [u, k] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(s) >= k) return rtf.format(Math.round(s / k), u);
  }
  return t('just now');
}
export const fdate = (ms, o = { day: 'numeric', month: 'short' }) => new Date(ms).toLocaleDateString(lang, o).replace('.', '');

/** Translates static HTML: data-i18n (text), data-i18n-title, data-i18n-aria, data-i18n-ph (placeholder). */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
}
