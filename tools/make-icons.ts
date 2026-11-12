/* ============================================================================
 * make-icons — the app's icon, drawn from one description.
 *
 *   npm run icons
 *
 * Writes public/favicon.svg and the PNGs a browser asks for when the app is
 * installed (192, 512, a maskable 512 and Apple's 180). All of them come from
 * the same few numbers below, so the tab icon and the installed one cannot
 * drift apart.
 *
 * The mark is a D built from a stem and a half ring — geometry rather than a
 * letter set in the reading face, because neither an SVG favicon nor a PNG
 * can use a web font, and a D that falls back to Times is not this app's D.
 *
 * No image library: a PNG is a zlib stream with a header, and Node ships
 * zlib. The shapes are tested per sub-pixel on a 4x4 grid, which is all the
 * anti-aliasing a flat two-colour mark needs.
 * ========================================================================== */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

/* The night printing's paper and the default accent, from styles/tokens.css,
   converted once: an icon is the one place an oklch() token cannot reach. */
const PAPER = oklch(0.21, 0.008, 70);
const ACCENT = oklch(0.62, 0.19, 262);

/* The mark, on a 64-unit square. */
const STEM = { x0: 19, x1: 27, y0: 16, y1: 48 };
const BOWL = { cx: 27, cy: 32, outer: 16, inner: 8 };
const CORNER = 14;

type RGB = [number, number, number];

function oklch(L: number, C: number, hDeg: number): RGB {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ];
  return lin.map((v) => {
    const c = Math.min(1, Math.max(0, v));
    const g = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(g * 255);
  }) as RGB;
}

const hex = (c: RGB) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");

/** Is this point (in 64-unit space) inside the D? */
function inMark(x: number, y: number): boolean {
  if (x >= STEM.x0 && x <= STEM.x1 && y >= STEM.y0 && y <= STEM.y1) return true;
  if (x < BOWL.cx) return false;
  const d = Math.hypot(x - BOWL.cx, y - BOWL.cy);
  return d <= BOWL.outer && d >= BOWL.inner;
}

/** Is this point inside the rounded square? */
function inPlate(x: number, y: number, r: number): boolean {
  const dx = Math.max(r - x, x - (64 - r), 0);
  const dy = Math.max(r - y, y - (64 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

/** `scale` shrinks the mark toward the centre — a maskable icon may be cropped
 *  to a circle, so its mark has to sit inside the middle 80%. `plate` false
 *  fills the whole square, which is what a maskable icon wants. */
function render(size: number, opts: { scale?: number; plate?: boolean } = {}): Buffer {
  const scale = opts.scale ?? 1;
  const plate = opts.plate ?? true;
  const SS = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let mark = 0;
      let inside = 0;
      for (let sj = 0; sj < SS; sj++) {
        for (let si = 0; si < SS; si++) {
          const x = ((i + (si + 0.5) / SS) / size) * 64;
          const y = ((j + (sj + 0.5) / SS) / size) * 64;
          if (plate && !inPlate(x, y, CORNER)) continue;
          inside++;
          if (inMark(32 + (x - 32) / scale, 32 + (y - 32) / scale)) mark++;
        }
      }
      const n = SS * SS;
      const t = inside ? mark / inside : 0;
      const o = (j * size + i) * 4;
      for (let k = 0; k < 3; k++) px[o + k] = Math.round(PAPER[k] + (ACCENT[k] - PAPER[k]) * t);
      px[o + 3] = Math.round((inside / n) * 255);
    }
  }
  return png(size, px);
}

function png(size: number, rgba: Buffer): Buffer {
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf: Buffer) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const { cx, cy, outer, inner } = BOWL;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="${CORNER}" fill="${hex(PAPER)}"/>
  <rect x="${STEM.x0}" y="${STEM.y0}" width="${STEM.x1 - STEM.x0}" height="${STEM.y1 - STEM.y0}" fill="${hex(ACCENT)}"/>
  <path fill="${hex(ACCENT)}" d="M${cx} ${cy - outer}a${outer} ${outer} 0 0 1 0 ${outer * 2}v-${outer - inner}a${inner} ${inner} 0 0 0 0-${inner * 2}z"/>
</svg>
`;

fs.writeFileSync(path.join(OUT, "favicon.svg"), svg);
fs.writeFileSync(path.join(OUT, "icon-192.png"), render(192));
fs.writeFileSync(path.join(OUT, "icon-512.png"), render(512));
fs.writeFileSync(path.join(OUT, "icon-maskable-512.png"), render(512, { scale: 0.72, plate: false }));
fs.writeFileSync(path.join(OUT, "apple-touch-icon.png"), render(180, { plate: false }));
console.log("icons written to public/ — paper", hex(PAPER), "accent", hex(ACCENT));
