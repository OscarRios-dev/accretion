// Builds the Accretion logo and every icon from one geometry.
//   npx electron build/make-icon.js
// Writes: build/logo.svg (+ -light), app/logo.svg, docs/logo.svg (+ -light), app/icon.png,
//         build/icon.ico (16–256) and build/icon.icns (16–1024). Rasterised by Chromium, no extra dependencies.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');

// The mark: a black hole's ring, the lensed far side of the disc arching over it, and the amber accretion disc
// crossing in front (its back half passes behind the ring). viewBox 0 0 100 100.
// `bold` thickens everything for 16–32 px, where hairline gaps and gradients would blur away.
function mark({ ink = '#ECECEE', bold = false, id = 'a' } = {}) {
  const ringW = bold ? 5.4 : 3.9, arcW = bold ? 4.8 : 3.6, gap = bold ? 1.5 : 1.7;
  const innerRy = bold ? 3.4 : 4.4;
  const C = { x: 52, y: 53 }, R = 18.2, A = 24.8;
  const tilt = 'rotate(-12.5 50 54)';
  const crescent = `M4 54A46 9.5 0 1 0 96 54A46 9.5 0 1 0 4 54ZM7.7 52.6A43.5 ${innerRy} 0 1 0 94.7 52.6A43.5 ${innerRy} 0 1 0 7.7 52.6Z`;
  const arc = `M${C.x - Math.sqrt(A * A - 4.8 * 4.8)} ${C.y - 4.8}A${A} ${A} 0 0 1 ${C.x + Math.sqrt(A * A - 4.8 * 4.8)} ${C.y - 4.8}`;
  const arcPaint = bold ? ink : `url(#${id}-arc)`;
  const discPaint = bold ? '#EAA867' : `url(#${id}-disc)`;
  return `<defs>
<linearGradient id="${id}-arc" x1="27" y1="0" x2="77" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${ink}"/><stop offset=".55" stop-color="${ink === '#ECECEE' ? '#F6E2C8' : ink}"/><stop offset="1" stop-color="#F4C38C"/></linearGradient>
<linearGradient id="${id}-disc" x1="4" y1="0" x2="96" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#E39A55"/><stop offset="1" stop-color="#F2BA80"/></linearGradient>
<path id="${id}-cres" fill-rule="evenodd" d="${crescent}"/>
<clipPath id="${id}-front"><rect x="-10" y="54" width="120" height="60"/></clipPath>
<clipPath id="${id}-back"><rect x="-10" y="-10" width="120" height="64.6"/></clipPath>
<mask id="${id}-cutFront" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><rect width="100" height="100" fill="#fff"/><g transform="${tilt}" clip-path="url(#${id}-front)"><use href="#${id}-cres" fill="#000" stroke="#000" stroke-width="${gap * 2}" stroke-linejoin="round"/></g></mask>
<mask id="${id}-cutRing" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><rect width="100" height="100" fill="#fff"/><circle cx="${C.x}" cy="${C.y}" r="${R + ringW / 2 + gap}" fill="#000"/><path d="${arc}" fill="none" stroke="#000" stroke-width="${arcW + gap * 2}"/></mask>
</defs>
<g mask="url(#${id}-cutRing)"><g transform="${tilt}" clip-path="url(#${id}-back)"><use href="#${id}-cres" fill="${discPaint}"/></g></g>
<g mask="url(#${id}-cutFront)"><circle cx="${C.x}" cy="${C.y}" r="${R}" fill="none" stroke="${ink}" stroke-width="${ringW}"/><path d="${arc}" fill="none" stroke="${arcPaint}" stroke-width="${arcW}"/></g>
<g transform="${tilt}" clip-path="url(#${id}-front)"><use href="#${id}-cres" fill="${discPaint}"/></g>`;
}
const svg = (body, label = 'Accretion') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="${label}">\n${body}\n</svg>\n`;

// App icon: the mark on a near-black rounded square. `margin` leaves the transparent border macOS icons use.
function tile({ bold = false, margin = 0 } = {}) {
  const s = 100 - margin * 2, k = bold ? 0.9 : 0.8;
  const off = margin + (s - s * k) / 2;
  return svg(`<rect x="${margin}" y="${margin}" width="${s}" height="${s}" rx="${s * 0.225}" fill="#0B0B0D"/>
<rect x="${margin + 0.5}" y="${margin + 0.5}" width="${s - 1}" height="${s - 1}" rx="${s * 0.225 - 0.5}" fill="none" stroke="#fff" stroke-opacity=".09"/>
<g transform="translate(${off} ${off}) scale(${(s * k) / 100})">${mark({ bold, id: bold ? 'b' : 'a' })}</g>`);
}

const write = (rel, data) => { fs.writeFileSync(path.join(root, rel), data); console.log('  ' + rel); };

async function rasterise(win, svgText, size) {
  const url = 'data:image/svg+xml;base64,' + Buffer.from(svgText).toString('base64');
  const data = await win.webContents.executeJavaScript(`new Promise((ok, no) => {
    const img = new Image(); img.onerror = () => no('svg failed');
    img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = ${size};
      const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, ${size}, ${size});
      ok(c.toDataURL('image/png')); };
    img.src = ${JSON.stringify(url)}; })`);
  return Buffer.from(data.split(',')[1], 'base64');
}

function ico(pngs) { // [{ size, png }] — PNG-compressed entries (Windows Vista and later)
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(({ size, png }, i) => {
    const e = 6 + i * 16;
    head[e] = size >= 256 ? 0 : size; head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += png.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.png)]);
}
function icns(entries) { // [{ type, png }]
  const parts = entries.map(({ type, png }) => {
    const h = Buffer.alloc(8); h.write(type, 0, 'ascii'); h.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([h, png]);
  });
  const h = Buffer.alloc(8); h.write('icns', 0, 'ascii'); h.writeUInt32BE(8 + parts.reduce((a, p) => a + p.length, 0), 4);
  return Buffer.concat([h, ...parts]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 64, height: 64 });
  await win.loadURL('data:text/html,<!doctype html><title>icon</title>');

  const logo = svg(mark()), logoLight = svg(mark({ ink: '#18181B' }));
  write('build/logo.svg', logo); write('build/logo-light.svg', logoLight);
  write('app/logo.svg', logo);
  write('docs/logo.svg', logo); write('docs/logo-light.svg', logoLight);

  const small = tile({ bold: true }), big = tile();
  const png = async (s, size) => rasterise(win, s, size);
  write('app/icon.png', await png(big, 256));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  write('build/icon.ico', ico(await Promise.all(sizes.map(async (size) => ({ size, png: await png(size <= 32 ? small : big, size) })))));
  const mac = tile({ margin: 10 }), macSmall = tile({ bold: true, margin: 6 });
  const types = [['icp4', 16, macSmall], ['icp5', 32, macSmall], ['icp6', 64, mac], ['ic07', 128, mac], ['ic08', 256, mac], ['ic09', 512, mac], ['ic10', 1024, mac]];
  write('build/icon.icns', icns(await Promise.all(types.map(async ([type, size, s]) => ({ type, png: await png(s, size) })))));
  write('build/icon-1024.png', await png(big, 1024));
  if (process.env.ICON_PREVIEW) { // dev: dump the small sizes to look at them
    for (const size of [16, 32]) fs.writeFileSync(path.join(process.env.ICON_PREVIEW, `icon-${size}.png`), await png(small, size));
  }
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
