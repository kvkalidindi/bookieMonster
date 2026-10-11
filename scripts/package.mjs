// Builds dist/bookieMonster-<version>.zip from extension/ — the file uploaded
// to the Chrome Web Store and attached to GitHub releases. Dependency-free
// (deflate via node:zlib).  Usage: node scripts/package.mjs
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'extension');
const { version } = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));

const walk = dir => readdirSync(dir).sort().flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

const locals = [], centrals = [];
let offset = 0;
for (const file of walk(src)) {
  const name = Buffer.from(relative(src, file).split('\\').join('/'));
  const data = readFileSync(file);
  const packed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const header = (sig, extra) => {
    const h = Buffer.alloc(sig === 0x04034b50 ? 30 : 46);
    let p = 0;
    h.writeUInt32LE(sig, p); p += 4;
    if (sig === 0x02014b50) { h.writeUInt16LE(20, p); p += 2; }   // version made by
    h.writeUInt16LE(20, p); p += 2;                               // version needed
    h.writeUInt16LE(0x0800, p); p += 2;                           // UTF-8 names
    h.writeUInt16LE(8, p); p += 2;                                // deflate
    h.writeUInt32LE(0x00210000, p); p += 4;                       // fixed DOS time: 1980-01-01
    h.writeUInt32LE(crc, p); p += 4;
    h.writeUInt32LE(packed.length, p); p += 4;
    h.writeUInt32LE(data.length, p); p += 4;
    h.writeUInt16LE(name.length, p); p += 2;
    h.writeUInt16LE(0, p); p += 2;                                // extra length
    if (extra) { p += 10; h.writeUInt32LE(extra.offset, p); }     // comment, disk, int/ext attrs, offset
    return h;
  };
  const local = Buffer.concat([header(0x04034b50), name, packed]);
  centrals.push(Buffer.concat([header(0x02014b50, { offset }), name]));
  locals.push(local);
  offset += local.length;
}
const central = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(centrals.length, 8);
end.writeUInt16LE(centrals.length, 10);
end.writeUInt32LE(central.length, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', `bookieMonster-${version}.zip`);
writeFileSync(out, Buffer.concat([...locals, central, end]));
console.log(`Wrote ${relative(root, out)} (${centrals.length} files).`);
