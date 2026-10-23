const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const AMBER = [0xe2, 0xa1, 0x4a];
const GREEN = [0x6f, 0xbf, 0xa0];
const INK = [0x14, 0x18, 0x1e];

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const name = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function inRoundRect(x, y, width, height, radius) {
  const cx = Math.min(Math.max(x, radius), width - radius);
  const cy = Math.min(Math.max(y, radius), height - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function coverage(test) {
  let hits = 0;
  const samples = 4;
  for (let sy = 0; sy < samples; sy += 1) {
    for (let sx = 0; sx < samples; sx += 1) {
      if (test((sx + 0.5) / samples, (sy + 0.5) / samples)) hits += 1;
    }
  }
  return hits / (samples * samples);
}

function over(bottom, color, alpha) {
  const source = Math.max(0, Math.min(1, alpha));
  const dest = bottom[3] / 255;
  const out = source + dest * (1 - source);
  if (out <= 0) return [0, 0, 0, 0];
  return [
    Math.round((color[0] * source + bottom[0] * dest * (1 - source)) / out),
    Math.round((color[1] * source + bottom[1] * dest * (1 - source)) / out),
    Math.round((color[2] * source + bottom[2] * dest * (1 - source)) / out),
    Math.round(out * 255),
  ];
}

function drawPixel(x, y, size) {
  const tile = coverage((sx, sy) => inRoundRect(x + sx, y + sy, size, size, size * 0.22));
  let pixel = over([0, 0, 0, 0], INK, tile);
  const mark = size * 0.3;
  const offset = size * 0.13;
  const radius = Math.max(1, size * 0.045);
  const origin = (size - (mark + offset)) / 2;
  const greenAt = origin + offset;
  pixel = over(pixel, GREEN, coverage((sx, sy) => inRoundRect(x + sx - greenAt, y + sy - greenAt, mark, mark, radius)));
  pixel = over(pixel, AMBER, coverage((sx, sy) => inRoundRect(x + sx - origin, y + sy - origin, mark, mark, radius)));
  return pixel;
}

function png(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = drawPixel(x, y, size);
      const offset = row + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + entries.length;
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const at = index * 16;
    entries[at] = image.size >= 256 ? 0 : image.size;
    entries[at + 1] = image.size >= 256 ? 0 : image.size;
    entries.writeUInt16LE(1, at + 4);
    entries.writeUInt16LE(32, at + 6);
    entries.writeUInt32LE(image.png.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += image.png.length;
  }
  return Buffer.concat([header, entries, ...images.map((image) => image.png)]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => ({ size, png: png(size) }));
const out = path.join(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, ico(images));
console.log(`Wrote ${out} (${images.length} sizes).`);
