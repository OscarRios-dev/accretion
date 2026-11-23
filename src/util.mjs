// Small shared helpers (no DOM, no three.js) — safe to import from tests.
export const DAY = 86400000;
export const WEEK = 7 * DAY;

export function hashStr(s) {
  let h = 2166136261;
  for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// Deterministic PRNG (mulberry32): the same vault always produces the same galaxy.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r());
export const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const ACCENTS = /[̀-ͯ]/g;
/** Lowercase + strip accents, for accent-insensitive matching. */
export const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(ACCENTS, '');
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** "20-Areas" -> "Areas", "my_notes" -> "my notes" */
export const prettyName = (s) => s.replace(/^\d+[-_ .]+/, '').replace(/[-_]+/g, ' ') || s;
export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

export function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** localStorage wrapper that never throws (private windows, blocked storage). */
export const store = {
  get(k, d) { try { const v = globalThis.localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { globalThis.localStorage.setItem(k, JSON.stringify(v)); } catch { /* no storage */ } },
};

export function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
