/** TAN + SIP world coordinate system (the subset SPHEREx uses). */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export interface WcsParams {
  crpix: [number, number];
  crval: [number, number];
  /** CDELT-scaled PC matrix: [[m11, m12], [m21, m22]] in deg/pixel */
  cd: [[number, number], [number, number]];
  ap?: Record<string, number>;
  bp?: Record<string, number>;
  apOrder?: number;
  bpOrder?: number;
}

export function wcsFromHeader(h: Record<string, any>): WcsParams {
  const num = (k: string, d = 0) => (h[k] === undefined ? d : Number(h[k]));
  const c1 = num("CDELT1", 1);
  const c2 = num("CDELT2", 1);
  const sip = (prefix: string, order: number) => {
    const out: Record<string, number> = {};
    for (let p = 0; p <= order; p++)
      for (let q = 0; p + q <= order; q++) {
        const k = `${prefix}_${p}_${q}`;
        if (h[k] !== undefined) out[`${p}_${q}`] = Number(h[k]);
      }
    return out;
  };
  const apOrder = num("AP_ORDER", 0);
  const bpOrder = num("BP_ORDER", 0);
  return {
    crpix: [num("CRPIX1"), num("CRPIX2")],
    crval: [num("CRVAL1"), num("CRVAL2")],
    cd: [
      [c1 * num("PC1_1", 1), c1 * num("PC1_2", 0)],
      [c2 * num("PC2_1", 0), c2 * num("PC2_2", 1)],
    ],
    ap: apOrder ? sip("AP", apOrder) : undefined,
    bp: bpOrder ? sip("BP", bpOrder) : undefined,
    apOrder,
    bpOrder,
  };
}

function poly(coef: Record<string, number> | undefined, order: number, u: number, v: number) {
  if (!coef) return 0;
  let s = 0;
  for (let p = 0; p <= order; p++)
    for (let q = 0; p + q <= order; q++) {
      const c = coef[`${p}_${q}`];
      if (c) s += c * Math.pow(u, p) * Math.pow(v, q);
    }
  return s;
}

/** sky (deg) -> 1-based FITS pixel coordinates of the (cutout) image. */
export function skyToPixel(w: WcsParams, ra: number, dec: number): [number, number] {
  const a0 = w.crval[0] * D2R;
  const d0 = w.crval[1] * D2R;
  const a = ra * D2R;
  const d = dec * D2R;
  const da = a - a0;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(da);
  const xi = ((Math.cos(d) * Math.sin(da)) / cosc) * R2D;
  const eta =
    ((Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(da)) / cosc) * R2D;
  // invert CD matrix
  const [[m11, m12], [m21, m22]] = w.cd;
  const det = m11 * m22 - m12 * m21;
  const U = (m22 * xi - m12 * eta) / det;
  const V = (-m21 * xi + m11 * eta) / det;
  const u = U + poly(w.ap, w.apOrder ?? 0, U, V);
  const v = V + poly(w.bp, w.bpOrder ?? 0, U, V);
  return [w.crpix[0] + u, w.crpix[1] + v];
}

/** TAN deprojection helper for a plain north-up grid centred on (ra0, dec0). */
export function tanToSky(ra0: number, dec0: number, xiDeg: number, etaDeg: number): [number, number] {
  const xi = xiDeg * D2R;
  const eta = etaDeg * D2R;
  const a0 = ra0 * D2R;
  const d0 = dec0 * D2R;
  const rho = Math.hypot(xi, eta);
  if (rho === 0) return [ra0, dec0];
  const c = Math.atan(rho);
  const dec = Math.asin(Math.cos(c) * Math.sin(d0) + (eta * Math.sin(c) * Math.cos(d0)) / rho);
  const ra =
    a0 +
    Math.atan2(xi * Math.sin(c), rho * Math.cos(d0) * Math.cos(c) - eta * Math.sin(d0) * Math.sin(c));
  return [(((ra * R2D) % 360) + 360) % 360, dec * R2D];
}

/** Forward TAN projection onto the north-up grid (returns xi, eta in degrees). */
export function skyToTan(ra0: number, dec0: number, ra: number, dec: number): [number, number] {
  const a0 = ra0 * D2R;
  const d0 = dec0 * D2R;
  const a = ra * D2R;
  const d = dec * D2R;
  const da = a - a0;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(da);
  return [
    ((Math.cos(d) * Math.sin(da)) / cosc) * R2D,
    ((Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(da)) / cosc) * R2D,
  ];
}
