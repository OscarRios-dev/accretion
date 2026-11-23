// Renders a note's markdown safely. Note content is untrusted: everything goes through DOMPurify
// with a strict allow-list, and attachments are resolved by the main process to vault:// URLs.
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { esc } from './util.mjs';
import { t } from './i18n.mjs';

marked.use({ gfm: true });

const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const AUDIO_RE = /\.(mp3|wav|m4a|ogg|flac)$/i;
const VIDEO_RE = /\.(mp4|webm|mov)$/i;

const PURIFY = {
  FORBID_TAGS: ['style', 'iframe', 'frame', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'base', 'link', 'object', 'embed', 'script', 'svg', 'math', 'template'],
  FORBID_ATTR: ['style', 'srcset', 'action', 'formaction', 'background', 'ping'],
  ALLOW_DATA_ATTR: true,
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|vault:)/i,
};
// Task checkboxes are re-added after sanitising (marked emits <input type=checkbox>).
const TASK_OPEN = '⁣TASK0⁣', TASK_DONE = '⁣TASK1⁣';

// Applies fn only outside fenced and inline code.
function outsideCode(md, fn) {
  return md.split(/(^\s{0,3}(?:```|~~~)[\s\S]*?^\s{0,3}(?:```|~~~)[^\n]*$|`[^`\n]*`)/m).map((part, i) => (i % 2 ? part : fn(part))).join('');
}

export function renderMd(md) {
  md = md.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---[ \t]*(\n|$)/, '');
  md = md.replace(/^(\s*[-*+] )\[ \]/gm, `$1${TASK_OPEN}`).replace(/^(\s*[-*+] )\[[xX]\]/gm, `$1${TASK_DONE}`);
  md = outsideCode(md, (s) => s
    .replace(/%%[\s\S]*?(?:%%|$)/g, '')
    .replace(/!\[\[([^\[\]|#\n]{1,300})(?:#[^\[\]|\n]{0,300})?(?:\|([^\[\]\n]{0,300}))?\]\]/g, (_m, target, al) => {
      const tg = target.trim();
      if (IMG_RE.test(tg)) { const w = /^\d+/.exec(al || ''); return `<img class="att" data-src="${esc(tg)}" alt="${esc(tg)}"${w ? ` width="${w[0]}"` : ''}>`; }
      if (AUDIO_RE.test(tg)) return `<audio class="att" controls data-src="${esc(tg)}"></audio>`;
      if (VIDEO_RE.test(tg)) return `<video class="att" controls data-src="${esc(tg)}"></video>`;
      if (/\.base$/i.test(tg)) return `<span class="embed">▦ ${esc(t('Base view'))}: ${esc(tg.replace(/\.base$/i, ''))}</span>`;
      if (/\.\w{2,5}$/.test(tg)) return `<span class="embed">📎 ${esc(tg)}</span>`;
      return `<a class="wl embed" data-t="${esc(tg)}">↳ ${esc(al || tg)}</a>`;
    })
    .replace(/\[\[([^\[\]|#^\n]{1,300})(?:[#^][^\[\]|\n]{0,300})?(?:\\?\|([^\[\]\n]{1,300}))?\]\]/g, (_m, target, al) => `<a class="wl" data-t="${esc(target.replace(/\\$/, '').trim())}">${esc(al || target.replace(/\\$/, ''))}</a>`)
    .replace(/==([^=\n]{1,500})==/g, '<mark>$1</mark>')
    .replace(/(^|[ \t])#([\p{L}\p{N}_\/-]{1,120})/gmu, (m0, pre, tag) => (/^\d+$/.test(tag) ? m0 : `${pre}<span class="tagref" data-tag="${esc(tag.toLowerCase())}">#${esc(tag)}</span>`)));
  const html = DOMPurify.sanitize(marked.parse(md), PURIFY);
  return html
    .replaceAll(TASK_OPEN, '<input type="checkbox" disabled aria-label="task">')
    .replaceAll(TASK_DONE, '<input type="checkbox" checked disabled aria-label="task done">');
}

const CALLOUT = { note: '#9fb3ff', info: '#9fb3ff', abstract: '#8fd2c6', summary: '#8fd2c6', tip: '#8fd2c6', success: '#8fd2ae', check: '#8fd2ae', done: '#8fd2ae', question: '#e9cf8a', help: '#e9cf8a', faq: '#e9cf8a', warning: '#e6a77f', caution: '#e6a77f', attention: '#e6a77f', failure: '#ff9b8f', fail: '#ff9b8f', missing: '#ff9b8f', danger: '#ff9b8f', error: '#ff9b8f', bug: '#ff9b8f', example: '#b7a6ff', quote: '#a8a8b0', cite: '#a8a8b0', todo: '#9fb3ff', important: '#8fd2c6' };

/**
 * Post-processes the rendered note: callouts, unresolved links, attachments.
 * @param {HTMLElement} body
 * @param {{resolve:(target)=>any, resolveAttachment:(target)=>Promise<string|null>, isCurrent:()=>boolean}} ctx
 */
export function enhanceBody(body, ctx) {
  for (const bq of body.querySelectorAll('blockquote')) {
    const p = bq.firstElementChild;
    if (!p || p.tagName !== 'P') continue;
    const m = /^\[!(\w+)\][+-]?[ \t]*([^\n]*)/.exec(p.textContent);
    if (!m) continue;
    const type = m[1].toLowerCase();
    const div = document.createElement('div');
    div.className = 'callout';
    div.style.setProperty('--cc', CALLOUT[type] || '#9fb3ff');
    const title = document.createElement('div');
    title.className = 'ct';
    title.textContent = m[2] || type[0].toUpperCase() + type.slice(1);
    // Drop the "[!type] title" line from the first paragraph, keep the rest.
    const first = p.innerHTML.split(/<br\s*\/?>|\n/);
    first.shift();
    p.innerHTML = DOMPurify.sanitize(first.join('<br>'), PURIFY);
    div.append(title, ...bq.childNodes);
    if (!p.textContent.trim() && !p.querySelector('img')) p.remove();
    bq.replaceWith(div);
  }
  for (const a of body.querySelectorAll('a.wl')) {
    if (!ctx.resolve(a.dataset.t)) { a.classList.add('missing'); a.title = t('This note doesn’t exist yet'); }
    a.tabIndex = 0;
  }
  for (const a of body.querySelectorAll('a[href]')) {
    if (/^https?:/i.test(a.getAttribute('href'))) a.title = a.getAttribute('href');
  }
  const media = [...body.querySelectorAll('[data-src]')];
  for (const img of body.querySelectorAll('img:not([data-src])')) {
    const src = img.getAttribute('src') || '';
    if (!src) { img.remove(); continue; }
    if (!/^(https?:|data:|vault:)/i.test(src)) { img.dataset.src = src; img.removeAttribute('src'); media.push(img); }
    else if (/^https?:/i.test(src)) { img.removeAttribute('src'); img.replaceWith(Object.assign(document.createElement('a'), { href: src, textContent: '🖼 ' + (img.alt || src) })); }
  }
  for (const el of media) {
    ctx.resolveAttachment(el.dataset.src).then((url) => {
      if (!ctx.isCurrent()) return;
      if (url) el.src = url;
      else el.replaceWith(Object.assign(document.createElement('span'), { className: 'embed', textContent: `📎 ${el.dataset.src} (${t('not found')})` }));
    });
  }
}
