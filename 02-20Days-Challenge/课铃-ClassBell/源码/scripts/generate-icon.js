/**
 * ClassBell icon generator — no native dependencies.
 *
 * Renders a rounded-square "calendar + check" mark at several sizes with
 * 4x supersampling, writes PNG files and a multi-size Windows .ico.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'build');
const ASSETS = path.join(__dirname, '..', 'src', 'assets');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(ASSETS, { recursive: true });

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

const COLORS = {
  ink: [18, 43, 37, 255],
  green: [31, 111, 92, 255],
  greenDark: [16, 66, 55, 255],
  cream: [248, 243, 232, 255],
  creamDim: [224, 214, 193, 255],
  gold: [218, 166, 72, 255],
  white: [255, 255, 255, 255],
  shadow: [6, 24, 20, 60]
};

function canvas(size) {
  return { size, data: new Uint8ClampedArray(size * size * 4) };
}

function blendPixel(c, x, y, color) {
  if (x < 0 || y < 0 || x >= c.size || y >= c.size) return;
  const i = (y * c.size + x) * 4;
  const a = color[3] / 255;
  const inv = 1 - a;
  c.data[i] = Math.round(color[0] * a + c.data[i] * inv);
  c.data[i + 1] = Math.round(color[1] * a + c.data[i + 1] * inv);
  c.data[i + 2] = Math.round(color[2] * a + c.data[i + 2] * inv);
  c.data[i + 3] = Math.round(color[3] + c.data[i + 3] * inv);
}

function insideRoundRect(px, py, x, y, w, h, r) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function fillRoundRect(c, x, y, w, h, r, color) {
  for (let py = Math.floor(y); py < Math.ceil(y + h); py++) {
    for (let px = Math.floor(x); px < Math.ceil(x + w); px++) {
      if (insideRoundRect(px + 0.5, py + 0.5, x, y, w, h, r)) {
        blendPixel(c, px, py, color);
      }
    }
  }
}

function fillCircle(c, cx, cy, r, color) {
  for (let py = Math.floor(cy - r); py <= Math.ceil(cy + r); py++) {
    for (let px = Math.floor(cx - r); px <= Math.ceil(cx + r); px++) {
      const dx = px + 0.5 - cx;
      const dy = py + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) blendPixel(c, px, py, color);
    }
  }
}

/** Draw a thick line segment with round caps. */
function strokeLine(c, x1, y1, x2, y2, width, color) {
  const r = width / 2;
  const minX = Math.floor(Math.min(x1, x2) - r - 1);
  const maxX = Math.ceil(Math.max(x1, x2) + r + 1);
  const minY = Math.floor(Math.min(y1, y2) - r - 1);
  const maxY = Math.ceil(Math.max(y1, y2) + r + 1);
  const vx = x2 - x1;
  const vy = y2 - y1;
  const len2 = vx * vx + vy * vy || 1;
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const qx = px + 0.5;
      const qy = py + 0.5;
      let t = ((qx - x1) * vx + (qy - y1) * vy) / len2;
      t = Math.max(0, Math.min(1, t));
      const dx = qx - (x1 + t * vx);
      const dy = qy - (y1 + t * vy);
      if (dx * dx + dy * dy <= r * r) blendPixel(c, px, py, color);
    }
  }
}

function gradientBackground(c) {
  const s = c.size;
  const pad = s * 0.035;
  const r = s * 0.215;
  for (let y = 0; y < s; y++) {
    const t = y / s;
    // Diagonal-ish gradient.
    for (let x = 0; x < s; x++) {
      const q = Math.min(1, Math.max(0, t * 0.82 + (x / s) * 0.18));
      const col = [
        Math.round(COLORS.greenDark[0] + (COLORS.green[0] - COLORS.greenDark[0]) * q),
        Math.round(COLORS.greenDark[1] + (COLORS.green[1] - COLORS.greenDark[1]) * q),
        Math.round(COLORS.greenDark[2] + (COLORS.green[2] - COLORS.greenDark[2]) * q),
        255
      ];
      if (insideRoundRect(x + 0.5, y + 0.5, pad, pad, s - pad * 2, s - pad * 2, r)) {
        blendPixel(c, x, y, col);
      }
    }
  }
}

function render(size) {
  const SS = 4;
  const s = size * SS;
  const c = canvas(s);
  const u = (v) => v * s; // 0..1 helper

  gradientBackground(c);

  // subtle gold hairline
  const pad = u(0.035);
  const radius = u(0.215);
  const border = Math.max(1, s * 0.005);
  for (let py = 0; py < s; py++) {
    for (let px = 0; px < s; px++) {
      const inside = insideRoundRect(px + 0.5, py + 0.5, pad, pad, s - pad * 2, s - pad * 2, radius);
      const insideInner = insideRoundRect(
        px + 0.5,
        py + 0.5,
        pad + border * 1.6,
        pad + border * 1.6,
        s - (pad + border * 1.6) * 2,
        s - (pad + border * 1.6) * 2,
        radius - border
      );
      if (inside && !insideInner) blendPixel(c, px, py, [218, 166, 72, 90]);
    }
  }

  // soft shadow behind the calendar
  fillRoundRect(c, u(0.235), u(0.275), u(0.56), u(0.53), u(0.055), COLORS.shadow);

  // calendar sheet
  fillRoundRect(c, u(0.215), u(0.245), u(0.57), u(0.535), u(0.06), COLORS.cream);

  // calendar header
  fillRoundRect(c, u(0.215), u(0.245), u(0.57), u(0.145), u(0.06), [43, 122, 99, 255]);
  // square off bottom corners of header
  fillRoundRect(c, u(0.215), u(0.335), u(0.57), u(0.06), 0, [43, 122, 99, 255]);

  // binding rings
  fillRoundRect(c, u(0.325), u(0.19), u(0.045), u(0.135), u(0.02), COLORS.cream);
  fillRoundRect(c, u(0.63), u(0.19), u(0.045), u(0.135), u(0.02), COLORS.cream);

  // date grid: three rows, two dots each, plus one gold "today"
  const dot = u(0.043);
  const xs = [0.31, 0.45, 0.59];
  const ys = [0.45, 0.56, 0.67];
  for (let ry = 0; ry < ys.length; ry++) {
    for (let rx = 0; rx < xs.length; rx++) {
      const isToday = ry === 1 && rx === 1;
      fillRoundRect(c, u(xs[rx]), u(ys[ry]), dot, dot, u(0.011),
        isToday ? COLORS.gold : COLORS.creamDim);
    }
  }

  // check badge
  const cx = u(0.755);
  const cy = u(0.755);
  const R = u(0.155);
  fillCircle(c, cx, cy, R + Math.max(1, s * 0.008), COLORS.cream);
  fillCircle(c, cx, cy, R, COLORS.gold);
  strokeLine(c, cx - R * 0.46, cy + R * 0.02, cx - R * 0.10, cy + R * 0.38,
    Math.max(1.6, s * 0.033), COLORS.white);
  strokeLine(c, cx - R * 0.10, cy + R * 0.38, cx + R * 0.50, cy - R * 0.35,
    Math.max(1.6, s * 0.033), COLORS.white);

  // downsample
  const out = canvas(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = (((y * SS + sy) * s) + (x * SS + sx)) * 4;
          const pa = c.data[i + 3] / 255;
          r += c.data[i] * pa;
          g += c.data[i + 1] * pa;
          b += c.data[i + 2] * pa;
          a += pa;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      if (a > 0) {
        out.data[o] = Math.round(r / a);
        out.data[o + 1] = Math.round(g / a);
        out.data[o + 2] = Math.round(b / a);
      }
      out.data[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* PNG / ICO encoding                                                  */
/* ------------------------------------------------------------------ */

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typ = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typ, data])));
  return Buffer.concat([len, typ, data, crc]);
}

function toPNG(c) {
  const raw = Buffer.alloc((c.size * 4 + 1) * c.size);
  for (let y = 0; y < c.size; y++) {
    raw[y * (c.size * 4 + 1)] = 0;
    Buffer.from(c.data.buffer, c.data.byteOffset + y * c.size * 4, c.size * 4)
      .copy(raw, y * (c.size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.size, 0);
  ihdr.writeUInt32BE(c.size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function toBMP(c) {
  const { size, data } = c;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(size * size * 4, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = ((size - 1 - y) * size + x) * 4;
      const dst = (y * size + x) * 4;
      pixels[dst] = data[src + 2];
      pixels[dst + 1] = data[src + 1];
      pixels[dst + 2] = data[src];
      pixels[dst + 3] = data[src + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size);
  return Buffer.concat([header, pixels, mask]);
}

function buildICO(sizes) {
  const images = sizes.map((size) => {
    const c = render(size);
    // PNG for large sizes, BMP for small (broad compatibility).
    const data = size >= 128 ? toPNG(c) : toBMP(c);
    return { size, data };
  });
  const dir = Buffer.alloc(6 + images.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach((img, i) => {
    const p = 6 + i * 16;
    dir[p] = img.size === 256 ? 0 : img.size;
    dir[p + 1] = img.size === 256 ? 0 : img.size;
    dir[p + 2] = 0;
    dir[p + 3] = 0;
    dir.writeUInt16LE(1, p + 4);
    dir.writeUInt16LE(32, p + 6);
    dir.writeUInt32LE(img.data.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += img.data.length;
  });
  return Buffer.concat([dir, ...images.map((i) => i.data)]);
}

/* ------------------------------------------------------------------ */

const ico = buildICO([16, 24, 32, 48, 64, 128, 256]);
fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);
fs.writeFileSync(path.join(OUT, 'icon.png'), toPNG(render(512)));
fs.writeFileSync(path.join(ASSETS, 'icon.png'), toPNG(render(512)));
fs.writeFileSync(path.join(ASSETS, 'tray.png'), toPNG(render(32)));
fs.writeFileSync(path.join(ASSETS, 'tray@2x.png'), toPNG(render(64)));
console.log('icon.ico', ico.length, 'bytes');
console.log('icon.png', fs.statSync(path.join(OUT, 'icon.png')).size, 'bytes');
