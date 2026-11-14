/**
 * Server-side SPHEREx data access: SIA queries, cutout download + cache,
 * FITS parsing and reprojection onto a common north-up grid.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  ALLOWED_IMAGE_PREFIX,
  BAD_BITS,
  CACHE_DIR,
  COLLECTIONS,
  FLAG_CATEGORIES,
  IRSA_BASE,
  MAX_CONCURRENT_DOWNLOADS,
} from "../config/spherex.ts";
import { findHdu, parseHdus, readImage, readWaveTable } from "./fits.ts";
import { skyToPixel, tanToSky, wcsFromHeader, type WcsParams } from "./wcs.ts";

/* ------------------------------------------------------------------ SIA */

export interface Frame {
  /** IRSA access URL of the full spectral image (cutouts are made from this) */
  url: string;
  obsId: string;
  det: number;
  /** MJD of exposure start */
  mjd: number;
  /** nominal wavelength range of the whole detector (µm) */
  wmin: number;
  wmax: number;
  exptime: number;
  collection: string;
}

const siaCache = new Map<string, { t: number; frames: Frame[] }>();

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      cur.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      cur.push(field);
      field = "";
      if (cur.length > 1 || cur[0] !== "") rows.push(cur);
      cur = [];
    } else field += c;
  }
  if (field !== "" || cur.length) {
    cur.push(field);
    rows.push(cur);
  }
  const head = rows.shift() ?? [];
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

/** Find every SPHEREx spectral image whose footprint contains the position. */
export async function queryFrames(ra: number, dec: number, collections?: string[]): Promise<Frame[]> {
  const cols = collections?.length ? collections : COLLECTIONS.map((c) => c.id);
  const key = `${ra.toFixed(4)}|${dec.toFixed(4)}|${cols.join(",")}`;
  const hit = siaCache.get(key);
  if (hit && Date.now() - hit.t < 10 * 60_000) return hit.frames;

  const results = await Promise.all(
    cols.map(async (collection) => {
      const u = new URL(`${IRSA_BASE}/SIA`);
      u.searchParams.set("COLLECTION", collection);
      u.searchParams.set("POS", `circle ${ra.toFixed(6)} ${dec.toFixed(6)} 0.005`);
      u.searchParams.set("RESPONSEFORMAT", "CSV");
      const r = await fetch(u, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`IRSA SIA ${collection}: HTTP ${r.status}`);
      const rows = parseCsv(await r.text());
      return rows
        .filter((x) => x.access_url && x.dataproduct_type === "image")
        .map<Frame>((x) => ({
          url: x.access_url,
          obsId: x.obs_id,
          det: Number(/SPHEREx-D(\d)/.exec(x.energy_bandpassname)?.[1] ?? 0),
          mjd: Number(x.t_min),
          wmin: Number(x.em_min) * 1e6,
          wmax: Number(x.em_max) * 1e6,
          exptime: Number(x.t_exptime),
          collection,
        }));
    }),
  );
  // Newest collection first in config -> first one wins for duplicated exposures.
  const seen = new Set<string>();
  const frames: Frame[] = [];
  for (const list of results)
    for (const f of list) {
      const k = `${f.obsId}|${f.det}`;
      if (seen.has(k) || !f.det) continue;
      seen.add(k);
      frames.push(f);
    }
  frames.sort((a, b) => a.mjd - b.mjd);
  siaCache.set(key, { t: Date.now(), frames });
  return frames;
}

/* --------------------------------------------------------------- cutouts */

export interface RawCutout {
  meta: {
    nx: number;
    ny: number;
    wcs: WcsParams;
    crpixW: [number, number];
    wave: { xs: number[]; ys: number[]; vals: number[]; nx: number; ny: number } | null;
    det: number;
    obsId: string;
    mjd: number;
    exptime: number;
    unit: string;
    omega: number; // arcsec^2 per native pixel
    quality: Record<string, string | number | boolean | null>;
  };
  image: Float32Array;
  flags: Int32Array;
  variance: Float32Array;
}

const QUALITY_KEYS = [
  "L1DQAFLG",
  "L2DQAFLG",
  "FINAST",
  "PXSRCMSK",
  "NSNOWSRC",
  "SNWSTRK",
  "PSF_FWHM",
  "SPS_ELAT",
  "ASTRONETSOLVED",
  "AURORA_CONT",
  "SHUTTLE_GLOW_CONT",
  "HE_AIRGLOW_CONT",
  "SATSTRKS",
  "NBLMSRCS",
  "SPS_FLAGS",
];

let active = 0;
const waiters: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT_DOWNLOADS) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

const inflight = new Map<string, Promise<RawCutout | null>>();

function cacheFile(key: string) {
  return path.resolve(CACHE_DIR, key.slice(0, 2), `${key}.bin`);
}

function encodeRaw(raw: RawCutout): Buffer {
  const meta = Buffer.from(JSON.stringify(raw.meta));
  const pad = (4 - ((4 + meta.length) % 4)) % 4;
  const head = Buffer.alloc(4);
  head.writeUInt32LE(meta.length + pad);
  return Buffer.concat([
    head,
    meta,
    Buffer.alloc(pad, 0x20),
    Buffer.from(raw.image.buffer, raw.image.byteOffset, raw.image.byteLength),
    Buffer.from(raw.flags.buffer, raw.flags.byteOffset, raw.flags.byteLength),
    Buffer.from(raw.variance.buffer, raw.variance.byteOffset, raw.variance.byteLength),
  ]);
}

function decodeRaw(buf: Buffer): RawCutout {
  const len = buf.readUInt32LE(0);
  const meta = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
  const n = meta.nx * meta.ny;
  // copy to aligned ArrayBuffers
  const ab = buf.buffer.slice(buf.byteOffset + 4 + len, buf.byteOffset + 4 + len + n * 12);
  return {
    meta,
    image: new Float32Array(ab, 0, n),
    flags: new Int32Array(ab, n * 4, n),
    variance: new Float32Array(ab, n * 8, n),
  };
}

function parseCutout(buf: Uint8Array, frame: Pick<Frame, "det" | "obsId" | "mjd" | "exptime">): RawCutout {
  const hdus = parseHdus(buf);
  const imgHdu = findHdu(hdus, "IMAGE");
  const flgHdu = findHdu(hdus, "FLAGS");
  const varHdu = findHdu(hdus, "VARIANCE");
  const waveHdu = findHdu(hdus, "WCS-WAVE");
  if (!imgHdu || !flgHdu) throw new Error("cutout without IMAGE/FLAGS");
  const h = imgHdu.header;
  const img = readImage(buf, imgHdu);
  const flg = readImage(buf, flgHdu);
  const variance = varHdu ? (readImage(buf, varHdu).data as Float32Array) : new Float32Array(img.nx * img.ny);
  const quality: RawCutout["meta"]["quality"] = {};
  for (const k of QUALITY_KEYS) if (h[k] !== undefined) quality[k] = h[k] as any;
  const mjdAvg = Number(h["MJD-AVG"] ?? frame.mjd);
  return {
    meta: {
      nx: img.nx,
      ny: img.ny,
      wcs: wcsFromHeader(h),
      crpixW: [Number(h["CRPIX1W"] ?? 0), Number(h["CRPIX2W"] ?? 0)],
      wave: waveHdu
        ? (() => {
            const t = readWaveTable(buf, waveHdu);
            return { xs: t.xs, ys: t.ys, vals: Array.from(t.vals), nx: t.nx, ny: t.ny };
          })()
        : null,
      det: Number(h["DETECTOR"] ?? frame.det),
      obsId: String(h["OBSID"] ?? frame.obsId),
      mjd: mjdAvg,
      exptime: Number(h["XPOSURE"] ?? frame.exptime),
      unit: String(h["BUNIT"] ?? "MJy/sr"),
      omega: Number(h["OMEGA_MEDIAN"] ?? 37.8),
      quality,
    },
    image: img.data as Float32Array,
    flags: flg.data as Int32Array,
    variance,
  };
}

/** Download (or read from disk cache) a cutout of a spectral image. null = no overlap / error. */
export async function getRawCutout(
  url: string,
  frame: Pick<Frame, "det" | "obsId" | "mjd" | "exptime">,
  cra: number,
  cdec: number,
  sizeDeg: number,
): Promise<RawCutout | null> {
  if (!url.startsWith(ALLOWED_IMAGE_PREFIX)) throw new Error("URL not allowed");
  const key = crypto
    .createHash("sha1")
    .update(`${url}|${cra.toFixed(4)}|${cdec.toFixed(4)}|${sizeDeg.toFixed(4)}`)
    .digest("hex");
  const file = cacheFile(key);
  try {
    const buf = await fs.readFile(file);
    if (buf.length === 1) return null; // negative cache
    return decodeRaw(buf);
  } catch {
    /* miss */
  }
  const existing = inflight.get(key);
  if (existing) return existing;

  const job = slot(async () => {
    const u = `${url}?center=${cra.toFixed(6)},${cdec.toFixed(6)}d&size=${sizeDeg.toFixed(5)}`;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(150_000) });
        if (r.status === 500 || r.status === 400) {
          // no overlap with the parent image
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, Buffer.from([0]));
          return null;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.length < 5000) {
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, Buffer.from([0]));
          return null;
        }
        const raw = parseCutout(buf, frame);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, encodeRaw(raw));
        return raw;
      } catch (e) {
        lastErr = e;
        await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
      }
    }
    throw lastErr;
  }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/* ------------------------------------------------------------ reprojection */

const BAD_MASK = BAD_BITS.reduce((m, b) => m | (1 << b), 0) >>> 0;

// source bit -> category index
const BIT_TO_CAT = new Map<number, number>();
FLAG_CATEGORIES.forEach((c, i) => c.bits.forEach((b) => BIT_TO_CAT.set(b, i)));
const OFFIMAGE_BIT = 1 << 15;

function categoryMask(flags: number): number {
  if (!flags) return 0;
  let m = 0;
  for (const [bit, cat] of BIT_TO_CAT) if ((flags >>> bit) & 1) m |= 1 << cat;
  return m;
}

export function waveAt(meta: RawCutout["meta"], px: number, py: number): { wave: number; bw: number } | null {
  const t = meta.wave;
  if (!t) return null;
  const x = 1 + (px - meta.crpixW[0]);
  const y = 1 + (py - meta.crpixW[1]);
  const locate = (arr: number[], v: number) => {
    if (v <= arr[0]) return [0, 0] as const;
    if (v >= arr[arr.length - 1]) return [arr.length - 2, 1] as const;
    let i = 0;
    while (arr[i + 1] < v) i++;
    return [i, (v - arr[i]) / (arr[i + 1] - arr[i])] as const;
  };
  const [i, fx] = locate(t.xs, x);
  const [j, fy] = locate(t.ys, y);
  const at = (ii: number, jj: number, k: number) => t.vals[k + 2 * (ii + t.nx * jj)];
  const interp = (k: number) => {
    const fxc = Math.min(Math.max(fx, 0), 1);
    const fyc = Math.min(Math.max(fy, 0), 1);
    return (
      at(i, j, k) * (1 - fxc) * (1 - fyc) +
      at(i + 1, j, k) * fxc * (1 - fyc) +
      at(i, j + 1, k) * (1 - fxc) * fyc +
      at(i + 1, j + 1, k) * fxc * fyc
    );
  };
  return { wave: interp(0), bw: interp(1) };
}

export interface AlignedFrame {
  n: number;
  scale: number;
  image: Float32Array;
  flags: Uint16Array;
  info: {
    wave: number | null;
    bw: number | null;
    det: number;
    obsId: string;
    mjd: number;
    exptime: number;
    unit: string;
    omega: number;
    coverage: number;
    /** category bit mask of flags found within 1.5 native px of the target */
    centerFlags: number;
    targetPix: [number, number] | null;
    /** d(wavelength)/d(output pixel) along i and j at the grid centre (µm/px) */
    wgrad: [number, number] | null;
    quality: Record<string, string | number | boolean | null>;
  };
}

/** Resample onto an N x N north-up TAN grid centred on (ra, dec), `scale` arcsec/pixel. */
export function reproject(raw: RawCutout, ra: number, dec: number, n: number, scale: number): AlignedFrame {
  const { nx, ny, wcs } = raw.meta;
  const out = new Float32Array(n * n).fill(NaN);
  const outFlags = new Uint16Array(n * n);
  const half = (n - 1) / 2;
  const s = scale / 3600;
  let valid = 0;

  const val = new Float32Array(nx * ny);
  for (let i = 0; i < val.length; i++) {
    const f = raw.flags[i] >>> 0;
    const v = raw.image[i];
    val[i] = f & BAD_MASK || !Number.isFinite(v) ? NaN : v;
  }

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [r, d] = tanToSky(ra, dec, (half - i) * s, (half - j) * s);
      const [px1, py1] = skyToPixel(wcs, r, d);
      const px = px1 - 1;
      const py = py1 - 1;
      const o = j * n + i;
      if (px < -0.5 || py < -0.5 || px > nx - 0.5 || py > ny - 0.5) {
        outFlags[o] = OFFIMAGE_BIT;
        continue;
      }
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const fx = px - x0;
      const fy = py - y0;
      let sum = 0;
      let wsum = 0;
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const xx = x0 + dx;
          const yy = y0 + dy;
          if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
          const v = val[yy * nx + xx];
          if (v !== v) continue;
          const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
          sum += v * w;
          wsum += w;
        }
      if (wsum >= 0.5) {
        out[o] = sum / wsum;
        valid++;
      }
      const nxp = Math.min(nx - 1, Math.max(0, Math.round(px)));
      const nyp = Math.min(ny - 1, Math.max(0, Math.round(py)));
      outFlags[o] = categoryMask(raw.flags[nyp * nx + nxp] >>> 0);
    }
  }

  const tp = skyToPixel(wcs, ra, dec);
  const tx = tp[0] - 1;
  const ty = tp[1] - 1;
  const inside = tx >= 0 && ty >= 0 && tx <= nx - 1 && ty <= ny - 1;
  let centerFlags = 0;
  if (inside)
    for (let yy = Math.max(0, Math.round(ty) - 1); yy <= Math.min(ny - 1, Math.round(ty) + 1); yy++)
      for (let xx = Math.max(0, Math.round(tx) - 1); xx <= Math.min(nx - 1, Math.round(tx) + 1); xx++)
        centerFlags |= categoryMask(raw.flags[yy * nx + xx] >>> 0);
  const w = waveAt(raw.meta, tx + 1, ty + 1);
  const probe = (di: number, dj: number) => {
    const [r, d] = tanToSky(ra, dec, -di * s, -dj * s);
    const [x, y] = skyToPixel(wcs, r, d);
    return waveAt(raw.meta, x, y)?.wave ?? null;
  };
  const [wa, wb, wc, wd] = [probe(8, 0), probe(-8, 0), probe(0, 8), probe(0, -8)];
  const wgrad: [number, number] | null =
    wa !== null && wb !== null && wc !== null && wd !== null ? [(wa - wb) / 16, (wc - wd) / 16] : null;
  return {
    n,
    scale,
    image: out,
    flags: outFlags,
    info: {
      wave: w?.wave ?? null,
      bw: w?.bw ?? null,
      det: raw.meta.det,
      obsId: raw.meta.obsId,
      mjd: raw.meta.mjd,
      exptime: raw.meta.exptime,
      unit: raw.meta.unit,
      omega: raw.meta.omega,
      coverage: valid / (n * n),
      centerFlags,
      targetPix: inside ? [tx, ty] : null,
      wgrad,
      quality: raw.meta.quality,
    },
  };
}

/** Binary wire format: u32 jsonLen | json (space padded to 4) | f32[n*n] image | u16[n*n] flags */
export function encodeAligned(a: AlignedFrame): Buffer {
  const meta = Buffer.from(JSON.stringify({ n: a.n, scale: a.scale, ...a.info }));
  const pad = (4 - ((4 + meta.length) % 4)) % 4;
  const head = Buffer.alloc(4);
  head.writeUInt32LE(meta.length + pad);
  return Buffer.concat([
    head,
    meta,
    Buffer.alloc(pad, 0x20),
    Buffer.from(a.image.buffer, a.image.byteOffset, a.image.byteLength),
    Buffer.from(a.flags.buffer, a.flags.byteOffset, a.flags.byteLength),
  ]);
}
