// Draws the bookieMonster icon (a bookmark ribbon with a bite taken out) at
// every size the manifest needs. Dependency-free: rasterises with 4x4
// supersampling and writes PNGs with node:zlib.  Usage: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const BLUE = [0x16, 0x49, 0x99];
const WHITE = [0xff, 0xff, 0xff];

/** Coverage of the artwork at a point in unit space [0,1]^2; returns colour or null. */
function shade(x, y, padded) {
  // Chrome's guidance: 128px icons carry 16px of transparent padding.
  const p = padded ? 0.125 : 0.02;
  if (x < p || x > 1 - p || y < p || y > 1 - p) return null;
  const u = (x - p) / (1 - 2 * p), v = (y - p) / (1 - 2 * p);
  // Ribbon: rectangle with a V notch at the bottom, bite out of the top-right.
  const inRect = u > 0.27 && u < 0.73 && v > 0.16 && v < 0.86;
  const notch = v > 0.86 - (0.18 * (1 - Math.abs(u - 0.5) / 0.23));
  const bite = (u - 0.73) ** 2 + (v - 0.16) ** 2 < 0.17 ** 2;
  if (inRect && !notch && !bite) return WHITE;
  // Two crumbs beside the bite.
  if ((u - 0.86) ** 2 + (v - 0.40) ** 2 < 0.035 ** 2) return WHITE;
  if ((u - 0.80) ** 2 + (v - 0.50) ** 2 < 0.025 ** 2) return WHITE;
  return BLUE;
}

function render(size) {
  const ss = 4, rows = [];
  for (let py = 0; py < size; py++) {
    const row = [0]; // PNG filter byte
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const c = shade((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, size >= 128);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
      }
      row.push(a ? Math.round(r / a) : 0, a ? Math.round(g / a) : 0, a ? Math.round(b / a) : 0, Math.round((a / (ss * ss)) * 255));
    }
    rows.push(Buffer.from(row));
  }
  return png(size, deflateSync(Buffer.concat(rows)));
}

function png(size, idat) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = buf => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const out = new URL('../extension/icons/', import.meta.url);
mkdirSync(out, { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(new URL(`icon${size}.png`, out), render(size));
writeFileSync(new URL('../docs/store/icon-512.png', import.meta.url), render(512));
console.log('Icons written.');
