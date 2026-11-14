/** Pixel-level utilities for the viewer: stacking, differencing, stretch, colour maps, photometry. */

export type Img = Float32Array;

export function median(values: number[]): number {
  if (!values.length) return NaN;
  const a = Float64Array.from(values).sort();
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function medianOfImage(img: Img): number {
  const v: number[] = [];
  for (let i = 0; i < img.length; i += 1) if (img[i] === img[i]) v.push(img[i]);
  return median(v);
}

export function subtractBackground(img: Img): Img {
  const m = medianOfImage(img);
  const out = new Float32Array(img.length);
  for (let i = 0; i < img.length; i++) out[i] = img[i] - m;
  return out;
}

/** NaN-aware mean or median coadd of equally sized images. */
export function stack(imgs: Img[], how: "mean" | "median"): Img {
  const n = imgs[0].length;
  const out = new Float32Array(n);
  if (imgs.length === 1) {
    out.set(imgs[0]);
    return out;
  }
  const buf: number[] = new Array(imgs.length);
  for (let p = 0; p < n; p++) {
    let k = 0;
    for (let i = 0; i < imgs.length; i++) {
      const v = imgs[i][p];
      if (v === v) buf[k++] = v;
    }
    if (!k) {
      out[p] = NaN;
      continue;
    }
    if (how === "mean") {
      let s = 0;
      for (let i = 0; i < k; i++) s += buf[i];
      out[p] = s / k;
    } else {
      const a = buf.slice(0, k).sort((x, y) => x - y);
      out[p] = k % 2 ? a[k >> 1] : (a[(k >> 1) - 1] + a[k >> 1]) / 2;
    }
  }
  return out;
}

export function subtract(a: Img, b: Img): Img {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
  return out;
}

/** Separable Gaussian blur that ignores NaNs (normalised convolution). */
export function smooth(img: Img, n: number, sigma: number): Img {
  if (sigma <= 0.05) return img;
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k: number[] = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const tmp = new Float32Array(img.length);
  const out = new Float32Array(img.length);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let s = 0;
      let w = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i;
        if (xx < 0 || xx >= n) continue;
        const v = img[y * n + xx];
        if (v !== v) continue;
        s += v * k[i + r];
        w += k[i + r];
      }
      tmp[y * n + x] = w > 0 ? s / w : NaN;
    }
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (img[y * n + x] !== img[y * n + x]) {
        out[y * n + x] = NaN;
        continue;
      }
      let s = 0;
      let w = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i;
        if (yy < 0 || yy >= n) continue;
        const v = tmp[yy * n + x];
        if (v !== v) continue;
        s += v * k[i + r];
        w += k[i + r];
      }
      out[y * n + x] = w > 0 ? s / w : NaN;
    }
  return out;
}

export function percentiles(img: Img, ps: number[], stride = 1): number[] {
  const v: number[] = [];
  for (let i = 0; i < img.length; i += stride) if (img[i] === img[i]) v.push(img[i]);
  if (!v.length) return ps.map(() => 0);
  v.sort((a, b) => a - b);
  return ps.map((p) => v[Math.min(v.length - 1, Math.max(0, Math.round((p / 100) * (v.length - 1))))]);
}

/* ---------------------------------------------------------------- colour */

export type CmapName = "gray" | "invert" | "inferno" | "heat" | "viridis";

const STOPS: Record<string, [number, number, number][]> = {
  inferno: [
    [0, 0, 4],
    [40, 11, 84],
    [101, 21, 110],
    [159, 42, 99],
    [212, 72, 66],
    [245, 125, 21],
    [250, 193, 39],
    [252, 255, 164],
  ],
  heat: [
    [0, 0, 0],
    [90, 8, 8],
    [190, 40, 10],
    [250, 120, 20],
    [255, 205, 80],
    [255, 255, 235],
  ],
  viridis: [
    [68, 1, 84],
    [65, 68, 135],
    [42, 120, 142],
    [34, 168, 132],
    [122, 209, 81],
    [253, 231, 37],
  ],
};

const lutCache = new Map<string, Uint8ClampedArray>();
export function lut(name: CmapName): Uint8ClampedArray {
  const hit = lutCache.get(name);
  if (hit) return hit;
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    let c: [number, number, number];
    if (name === "gray") c = [i, i, i];
    else if (name === "invert") c = [255 - i, 255 - i, 255 - i];
    else {
      const s = STOPS[name];
      const t = (i / 255) * (s.length - 1);
      const a = Math.min(Math.floor(t), s.length - 2);
      const f = t - a;
      c = [0, 1, 2].map((k) => s[a][k] + (s[a + 1][k] - s[a][k]) * f) as [number, number, number];
    }
    out.set(c, i * 3);
  }
  lutCache.set(name, out);
  return out;
}

export type Stretch = "linear" | "asinh" | "sqrt" | "log";

function curve(t: number, mode: Stretch): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  switch (mode) {
    case "asinh":
      return Math.asinh(t * 10) / Math.asinh(10);
    case "sqrt":
      return Math.sqrt(t);
    case "log":
      return Math.log10(1 + 999 * t) / 3;
    default:
      return t;
  }
}

export interface RenderOpts {
  lo: number;
  hi: number;
  stretch: Stretch;
  cmap: CmapName;
  /** show masked (NaN) pixels as a magenta tint */
  showMasked: boolean;
}

export function toRGBA(img: Img, n: number, o: RenderOpts, out?: ImageData): ImageData {
  const id = out ?? new ImageData(n, n);
  const L = lut(o.cmap);
  const span = o.hi - o.lo || 1;
  const d = id.data;
  for (let i = 0; i < img.length; i++) {
    const v = img[i];
    const p = i * 4;
    if (v !== v) {
      if (o.showMasked) {
        d[p] = 150;
        d[p + 1] = 30;
        d[p + 2] = 140;
        d[p + 3] = 255;
      } else {
        const c = o.cmap === "invert" ? 40 : 0;
        d[p] = d[p + 1] = d[p + 2] = c;
        d[p + 3] = 255;
      }
      continue;
    }
    const k = Math.round(curve((v - o.lo) / span, o.stretch) * 255) * 3;
    d[p] = L[k];
    d[p + 1] = L[k + 1];
    d[p + 2] = L[k + 2];
    d[p + 3] = 255;
  }
  return id;
}

/* ------------------------------------------------------------- photometry */

export interface Photometry {
  /** background subtracted aperture sum in Jy (NaN when unusable) */
  flux: number;
  err: number;
  bkg: number;
  /** fraction of valid aperture pixels */
  valid: number;
  /** peak signal / background scatter */
  snr: number;
}

const SR_PER_ARCSEC2 = 2.350443e-11;

/**
 * Circular aperture photometry on a surface-brightness image (MJy/sr).
 * (x, y) in output pixel coordinates (0-based), radii in arcsec.
 */
export function aperture(
  img: Img,
  n: number,
  x: number,
  y: number,
  scale: number,
  rAp: number,
  oversample: number,
): Photometry {
  const rA = rAp / scale;
  const r0 = rA + 6 / scale;
  const r1 = rA + 20 / scale;
  const ann: number[] = [];
  let sum = 0;
  let cnt = 0;
  let tot = 0;
  let peak = -Infinity;
  const xmin = Math.max(0, Math.floor(x - r1));
  const xmax = Math.min(n - 1, Math.ceil(x + r1));
  const ymin = Math.max(0, Math.floor(y - r1));
  const ymax = Math.min(n - 1, Math.ceil(y + r1));
  const inside: number[] = [];
  for (let j = ymin; j <= ymax; j++)
    for (let i = xmin; i <= xmax; i++) {
      const r = Math.hypot(i - x, j - y);
      const v = img[j * n + i];
      if (r <= rA) {
        tot++;
        if (v === v) {
          inside.push(v);
          cnt++;
        }
      } else if (r >= r0 && r <= r1 && v === v) ann.push(v);
    }
  const bad = { flux: NaN, err: NaN, bkg: NaN, valid: tot ? cnt / tot : 0, snr: NaN };
  if (!tot || cnt / tot < 0.6 || ann.length < 12) return bad;
  const bkg = median(ann);
  const mad = median(ann.map((v) => Math.abs(v - bkg))) * 1.4826;
  for (const v of inside) {
    sum += v - bkg;
    if (v - bkg > peak) peak = v - bkg;
  }
  // scale the sum over valid pixels to the full aperture area
  sum *= tot / cnt;
  const omega = scale * scale * SR_PER_ARCSEC2; // sr per output pixel
  const flux = sum * omega * 1e6;
  const err = mad * Math.sqrt(tot) * oversample * omega * 1e6;
  return { flux, err, bkg, valid: cnt / tot, snr: mad > 0 ? peak / mad : NaN };
}

export function formatFlux(jy: number): { v: number; unit: string } {
  const a = Math.abs(jy);
  if (!Number.isFinite(a)) return { v: NaN, unit: "Jy" };
  if (a >= 1) return { v: jy, unit: "Jy" };
  if (a >= 1e-3) return { v: jy * 1e3, unit: "mJy" };
  return { v: jy * 1e6, unit: "µJy" };
}
