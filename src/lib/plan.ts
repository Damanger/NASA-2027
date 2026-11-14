/** Logic shared by the browser app and the prefetch script. */
import { NATIVE_SCALE, OVERSAMPLE } from "../config/spherex.ts";

export interface FrameInfo {
  url: string;
  obsId: string;
  det: number;
  mjd: number;
  wmin: number;
  wmax: number;
  exptime: number;
  collection: string;
}

export interface Position {
  ra: number;
  dec: number;
  /** epoch of ra/dec (Julian year) */
  epoch: number;
  /** mas/yr (pmra includes cos dec) */
  pmra: number;
  pmdec: number;
}

export const mjdToYear = (mjd: number) => 2000 + (mjd - 51544.5) / 365.25;
export const yearToMjd = (y: number) => (y - 2000) * 365.25 + 51544.5;

/** Linear proper-motion propagation. */
export function propagate(p: Position, year: number): { ra: number; dec: number } {
  const dt = year - p.epoch;
  const dec = p.dec + (p.pmdec * dt) / 3.6e6;
  const cosd = Math.cos((p.dec * Math.PI) / 180);
  const ra = p.ra + (p.pmra * dt) / 3.6e6 / Math.max(cosd, 1e-6);
  return { ra: ((ra % 360) + 360) % 360, dec };
}

export const gridScale = NATIVE_SCALE / OVERSAMPLE;

export function gridSize(fovArcmin: number): number {
  return Math.min(400, Math.max(16, Math.round((fovArcmin * 60) / gridScale)));
}

/**
 * Side (deg) of the IRSA cutout that is needed to fill a rotated square field of
 * `fovArcmin`, including a margin for the target's proper motion when co-moving.
 */
export function cutoutSizeDeg(fovArcmin: number, motionMarginDeg = 0): number {
  const fov = fovArcmin / 60;
  return Math.round((fov * Math.SQRT2 * 1.06 + 2 * motionMarginDeg + 0.01) * 1e4) / 1e4;
}

/** Evenly pick `max` frames in time, balanced between the selected detectors. */
export function selectFrames(frames: FrameInfo[], dets: number[], max: number): FrameInfo[] {
  const pool = frames.filter((f) => dets.includes(f.det));
  if (pool.length <= max) return pool;
  const per = Math.max(1, Math.floor(max / Math.max(dets.length, 1)));
  const out: FrameInfo[] = [];
  for (const d of dets) {
    const list = pool.filter((f) => f.det === d);
    if (list.length <= per) out.push(...list);
    else for (let i = 0; i < per; i++) out.push(list[Math.round((i * (list.length - 1)) / Math.max(per - 1, 1))]);
  }
  return out.sort((a, b) => a.mjd - b.mjd);
}

export function frameQuery(
  f: FrameInfo,
  o: { ra: number; dec: number; cra: number; cdec: number; size: number; n: number },
): string {
  const q = new URLSearchParams({
    u: f.url,
    obs: f.obsId,
    det: String(f.det),
    mjd: String(f.mjd),
    exp: String(f.exptime),
    ra: o.ra.toFixed(6),
    dec: o.dec.toFixed(6),
    cra: o.cra.toFixed(3),
    cdec: o.cdec.toFixed(3),
    size: String(o.size),
    n: String(o.n),
    scale: String(gridScale),
  });
  return q.toString();
}
