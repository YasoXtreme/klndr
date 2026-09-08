#!/usr/bin/env node
/**
 * Builds the derived brand assets out of the kit in `brand/`: the icons the app
 * serves, and the carded lockup the README uses.
 *
 * Run it after changing anything in brand/png:
 *   node scripts/build-brand-assets.js
 *
 * It writes one file back into brand/png (the card). That is not circular - the
 * card is composed from klndr-lockup-horizontal.png and never from itself, so
 * re-running is idempotent.
 *
 * No dependencies on purpose. klndr ships four production packages, and pulling
 * in an image toolchain for two resizes and an .ico would be the largest thing
 * in the tree. Everything below is Node's own zlib plus the PNG and ICO
 * container formats, both of which are short.
 *
 * Why the icons come from PNG and not from the kit's SVGs: the `k` in every mark
 * is ElmsSans Black, and ElmsSans is a variable font whose DEFAULT instance is
 * Thin. The kit's SVGs draw the glyph as live <text> with no font-family and no
 * font-weight, so anything that redraws them at render time - an <img>, an SVG
 * favicon - comes out thin and serif. The PNGs already have the weight
 * rasterised in.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'brand', 'png');
const OUT = path.join(ROOT, 'public', 'assets');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// The card around the README lockup. The kit renders at 2x, so these are the
// app's own tokens doubled: --radius-xl 20px, --border-thick 2.5px, and a
// 28px breathing space around the mark.
const CARD_PADDING = 56;
const CARD_RADIUS = 40;
const CARD_BORDER = 5;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ==========================================
// PNG decode
// ==========================================

/** Returns { width, height, data }, where data is 8-bit straight RGBA. */
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');

  let width = 0;
  let height = 0;
  const idat = [];

  for (let off = 8; off < buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colorType = body[9];
      const interlace = body[12];
      // The kit exports 8-bit RGBA, non-interlaced. Rather than carry a decoder
      // for the other combinations, refuse anything else loudly.
      if (depth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error(
          `unsupported PNG: depth ${depth}, colorType ${colorType}, interlace ${interlace}`
        );
      }
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const data = Buffer.alloc(height * stride);

  // Undo the per-row filter (PNG spec 9.2). `a` is the byte four to the left,
  // `b` the one above, `c` above-left; all read as zero outside the image.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x];
      const a = x >= 4 ? data[dst + x - 4] : 0;
      const b = y > 0 ? data[dst - stride + x] : 0;
      const c = x >= 4 && y > 0 ? data[dst - stride + x - 4] : 0;
      let out;
      switch (filter) {
        case 0: out = value; break;
        case 1: out = value + a; break;
        case 2: out = value + b; break;
        case 3: out = value + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          out = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`unknown row filter ${filter}`);
      }
      data[dst + x] = out & 0xff;
    }
  }

  return { width, height, data };
}

// ==========================================
// PNG encode
// ==========================================

function chunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'latin1');
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

function encodePng(img) {
  const stride = img.width * 4;
  const raw = Buffer.alloc(img.height * (stride + 1));
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0; // filter None: these are tiny and flat
    img.data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // bytes 10-12 (compression, filter, interlace) all stay 0

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ==========================================
// Resample
// ==========================================

/**
 * Area-average downscale, done on premultiplied alpha.
 *
 * Averaging straight RGBA would pull the colour of fully transparent pixels into
 * the edge, which on a black-bordered mark over transparency reads as a grey
 * halo. Premultiplying weights each pixel's colour by its own coverage, which is
 * what "the average of what you can actually see" means.
 */
function resize(img, width, height) {
  const out = Buffer.alloc(width * height * 4);
  const scaleX = img.width / width;
  const scaleY = img.height / height;

  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.ceil((y + 1) * scaleY));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.ceil((x + 1) * scaleX));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1 && sy < img.height; sy++) {
        for (let sx = x0; sx < x1 && sx < img.width; sx++) {
          const i = (sy * img.width + sx) * 4;
          const alpha = img.data[i + 3] / 255;
          r += img.data[i] * alpha;
          g += img.data[i + 1] * alpha;
          b += img.data[i + 2] * alpha;
          a += img.data[i + 3];
          n++;
        }
      }

      const o = (y * width + x) * 4;
      const avgAlpha = a / n;
      if (avgAlpha === 0) {
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
        out[o + 3] = 0;
      } else {
        const unpremultiply = 255 / avgAlpha;
        out[o] = Math.min(255, Math.round((r / n) * unpremultiply));
        out[o + 1] = Math.min(255, Math.round((g / n) * unpremultiply));
        out[o + 2] = Math.min(255, Math.round((b / n) * unpremultiply));
        out[o + 3] = Math.round(avgAlpha);
      }
    }
  }

  return { width, height, data: out };
}

/** Apple asks for no transparency on a touch icon, so flatten it onto paper. */
function flatten(img, [br, bg, bb]) {
  const out = Buffer.alloc(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    const alpha = img.data[i + 3] / 255;
    out[i] = Math.round(img.data[i] * alpha + br * (1 - alpha));
    out[i + 1] = Math.round(img.data[i + 1] * alpha + bg * (1 - alpha));
    out[i + 2] = Math.round(img.data[i + 2] * alpha + bb * (1 - alpha));
    out[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}

// ==========================================
// Card
// ==========================================

/** Is (x, y) inside the rounded rect at (x0, y0, w, h) with corner radius r? */
function insideRoundedRect(x, y, x0, y0, w, h, r) {
  const x1 = x0 + w;
  const y1 = y0 + h;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  if (r <= 0) return true;
  // Clamp to the straight core: on an edge one delta is zero and the test
  // reduces to the edge itself, in a corner both land on the arc's centre.
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * A rounded card: opaque `fill` inside a hard `border`, transparent outside.
 *
 * This exists for surfaces klndr does not control. Every mark in the kit is
 * black on transparency, so anything that renders one on a dark ground - a
 * GitHub README in dark mode, a dark email client - gets black on black. The
 * card supplies the light ground the marks were drawn for, and it has to be
 * baked into the pixels because the places that need it are the same places
 * that strip CSS.
 *
 * Coverage is sampled rather than tested once per pixel. A hard border on a
 * 40px radius is exactly where a binary inside/outside test shows its stairs.
 */
function roundedCard(width, height, radius, border, fill, borderColor) {
  const data = Buffer.alloc(width * height * 4);
  const SAMPLES = 4;
  const total = SAMPLES * SAMPLES;
  const step = 1 / SAMPLES;
  const origin = step / 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let outer = 0;
      let inner = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        const py = y + origin + sy * step;
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = x + origin + sx * step;
          if (insideRoundedRect(px, py, 0, 0, width, height, radius)) outer++;
          if (
            insideRoundedRect(
              px, py,
              border, border,
              width - border * 2, height - border * 2,
              radius - border
            )
          ) inner++;
        }
      }

      if (outer === 0) continue;

      const alpha = outer / total;
      const fillWeight = inner / total;
      // The border is whatever the outline covers that the fill does not.
      const borderWeight = Math.max(0, alpha - fillWeight);
      const o = (y * width + x) * 4;

      // Average in premultiplied space, then divide the coverage back out -
      // straight-alpha averaging would drag the transparent outside into the
      // corners as a light halo, the same trap resize() avoids.
      for (let c = 0; c < 3; c++) {
        data[o + c] = Math.round(
          (fill[c] * fillWeight + borderColor[c] * borderWeight) / alpha
        );
      }
      data[o + 3] = Math.round(alpha * 255);
    }
  }

  return { width, height, data };
}

/** Source-over composite of `src` onto `dst` at (dx, dy). Both straight RGBA. */
function drawOnto(dst, src, dx, dy) {
  for (let y = 0; y < src.height; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= dst.width) continue;

      const s = (y * src.width + x) * 4;
      const d = (ty * dst.width + tx) * 4;
      const sa = src.data[s + 3] / 255;
      if (sa === 0) continue;

      const da = dst.data[d + 3] / 255;
      const outA = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) {
        dst.data[d + c] = Math.round(
          (src.data[s + c] * sa + dst.data[d + c] * da * (1 - sa)) / outA
        );
      }
      dst.data[d + 3] = Math.round(outA * 255);
    }
  }
  return dst;
}

// ==========================================
// ICO
// ==========================================

/**
 * A 32bpp BMP entry rather than an embedded PNG. PNG-in-ICO needs Vista or
 * newer, and favicon.ico only exists for the clients that ignore the <link>
 * tags in the first place, so it may as well be the form all of them read.
 */
function bmpEntry(img) {
  const { width, height, data } = img;
  const maskStride = ((width + 31) >> 5) * 4; // 1bpp, rows padded to 4 bytes

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8); // colour rows plus mask rows
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bpp
  header.writeUInt32LE(width * height * 4 + maskStride * height, 20);

  const pixels = Buffer.alloc(width * height * 4);
  const mask = Buffer.alloc(maskStride * height); // all zero: nothing masked out
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4; // BMP rows run bottom-up
    for (let x = 0; x < width; x++) {
      const i = src + x * 4;
      const o = (y * width + x) * 4;
      pixels[o] = data[i + 2]; // B
      pixels[o + 1] = data[i + 1]; // G
      pixels[o + 2] = data[i]; // R
      pixels[o + 3] = data[i + 3]; // A
    }
  }

  return Buffer.concat([header, pixels, mask]);
}

function encodeIco(images) {
  const bodies = images.map(bmpEntry);
  const dir = Buffer.alloc(6 + images.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(images.length, 4);

  let offset = dir.length;
  images.forEach((img, i) => {
    const e = 6 + i * 16;
    dir[e] = img.width === 256 ? 0 : img.width;
    dir[e + 1] = img.height === 256 ? 0 : img.height;
    dir.writeUInt16LE(1, e + 4); // planes
    dir.writeUInt16LE(32, e + 6); // bpp
    dir.writeUInt32LE(bodies[i].length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += bodies[i].length;
  });

  return Buffer.concat([dir, ...bodies]);
}

// ==========================================
// Build
// ==========================================

function load(name) {
  return decodePng(fs.readFileSync(path.join(SRC, name)));
}

function write(name, buf) {
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log(`  ${name.padEnd(24)} ${String(buf.length).padStart(7)} bytes  public/assets`);
}

function writeKit(name, buf) {
  fs.writeFileSync(path.join(SRC, name), buf);
  console.log(`  ${name.padEnd(24)} ${String(buf.length).padStart(7)} bytes  brand/png`);
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('building klndr icons from brand/png');

  // Every favicon size comes off the micro tile - the solid black plate with a
  // white k. The mint plate is the right mark at display sizes, but a tab is 16
  // to 32 pixels of pale mint behind a hairline border, which reads as an empty
  // outline rather than a badge. The tile keeps its weight all the way down.
  const tile = load('klndr-favicon-tile.png');
  const sizes = [16, 32, 48].map(px => resize(tile, px, px));

  sizes.forEach(img => write(`favicon-${img.width}.png`, encodePng(img)));
  write('favicon.ico', encodeIco(sizes));

  // The home screen is not a tab: it is full bleed on someone else's wallpaper,
  // so it keeps the mint field the kit designed for it. Flattened onto white
  // because Apple asks for no transparency.
  const appIcon = load('klndr-app-icon.png');
  write('apple-touch-icon.png', encodePng(flatten(resize(appIcon, 180, 180), [255, 255, 255])));

  // The carded lockup. Everything above serves the app, where the page owns the
  // background; this one serves the README, where it does not.
  //
  // The card is WHITE rather than mint, by the kit's own rule that the plate
  // takes the colour its surface is not: these exports are mint-plated, and a
  // mint card would collapse the badge into a bare outline.
  const lockup = load('klndr-lockup-horizontal.png');
  const card = roundedCard(
    lockup.width + CARD_PADDING * 2,
    lockup.height + CARD_PADDING * 2,
    CARD_RADIUS,
    CARD_BORDER,
    [255, 255, 255],
    [0, 0, 0]
  );
  drawOnto(card, lockup, CARD_PADDING, CARD_PADDING);
  writeKit('klndr-lockup-card.png', encodePng(card));
}

main();
