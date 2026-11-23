// Genera app/icon.png y build/icon.ico (agujero negro con disco) sin dependencias.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 256;
const px = Buffer.alloc(S * S * 4);
const clamp = (x) => Math.max(0, Math.min(1, x));
for (let j = 0; j < S; j++) {
  for (let i = 0; i < S; i++) {
    const x = (i + 0.5) / S - 0.5, y = (j + 0.5) / S - 0.5;
    const r = Math.hypot(x, y);
    // Fondo circular oscuro.
    let a = clamp((0.5 - r) * S * 0.5);
    let cr = 0.04, cg = 0.05, cb = 0.12;
    const add = (k, R, G, B) => { cr += R * k; cg += G * k; cb += B * k; };
    // Halo de luz lensada (anillo de fotones + disco trasero curvado).
    add(Math.exp(-(((r - 0.215) / 0.035) ** 2)) * 1.1, 1.0, 0.68, 0.32);
    add(Math.exp(-(((r - 0.2) / 0.012) ** 2)) * 0.9, 1.0, 0.92, 0.8);
    // Sombra.
    const shadow = clamp((0.17 - r) * S * 0.25);
    cr *= 1 - shadow; cg *= 1 - shadow; cb *= 1 - shadow;
    // Disco frontal (elipse delgada) por encima de la sombra.
    const e = Math.hypot(x / 0.42, (y - 0.01) / 0.075);
    const band = Math.exp(-(((e - 0.75) / 0.2) ** 2)) * clamp((0.42 - Math.abs(x)) * 30);
    const hot = 0.6 + 0.6 * clamp(-x * 3 + 0.5);    // lado que se acerca más brillante
    add(band * hot, 1.0, 0.62, 0.25);
    add(band * hot * 0.5 * Math.exp(-(((e - 0.7) / 0.08) ** 2)), 1, 0.95, 0.85);
    // Estrellitas.
    const h = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
    if (h - Math.floor(h) > 0.996 && r > 0.3) add(0.8, 0.8, 0.85, 1);
    const k = (i + j * S) * 4;
    px[k] = Math.round(clamp(cr) * 255);
    px[k + 1] = Math.round(clamp(cg) * 255);
    px[k + 2] = Math.round(clamp(cb) * 255);
    px[k + 3] = Math.round(a * 255);
  }
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let j = 0; j < S; j++) { raw[j * (S * 4 + 1)] = 0; px.copy(raw, j * (S * 4 + 1) + 1, j * S * 4, (j + 1) * S * 4); }
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);

// ICO con una imagen PNG de 256 px.
const head = Buffer.alloc(22);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
head[6] = 0; head[7] = 0; head[8] = 0; head[9] = 0;
head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);

const root = path.join(__dirname, '..');
fs.writeFileSync(path.join(root, 'app', 'icon.png'), png);
fs.writeFileSync(path.join(__dirname, 'icon.ico'), Buffer.concat([head, png]));
console.log('icono listo');
