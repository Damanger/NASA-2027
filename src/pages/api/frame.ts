import type { APIRoute } from "astro";
import { ALLOWED_IMAGE_PREFIX } from "../../config/spherex.ts";
import { encodeAligned, getRawCutout, reproject } from "../../lib/spherex.ts";

/**
 * One aligned frame: downloads the IRSA cutout (cached on disk), reprojects it onto a
 * north-up grid centred on (ra, dec) and returns it as compact binary.
 */
export const GET: APIRoute = async ({ url }) => {
  const q = url.searchParams;
  const u = q.get("u") ?? "";
  const num = (k: string, d?: number) => {
    const v = q.get(k);
    return v === null || v === "" ? (d as number) : Number(v);
  };
  const ra = num("ra");
  const dec = num("dec");
  const cra = num("cra", ra);
  const cdec = num("cdec", dec);
  const size = Math.min(Math.max(num("size", 0.2), 0.02), 1.5); // cutout side, deg
  const n = Math.min(Math.max(Math.round(num("n", 100)), 8), 400);
  const scale = Math.min(Math.max(num("scale", 3.075), 0.5), 60);
  if (!u.startsWith(ALLOWED_IMAGE_PREFIX) || ![ra, dec, cra, cdec].every(Number.isFinite))
    return new Response("bad request", { status: 400 });
  try {
    const raw = await getRawCutout(
      u,
      { det: num("det", 0), obsId: q.get("obs") ?? "", mjd: num("mjd", 0), exptime: num("exp", 0) },
      cra,
      cdec,
      size,
    );
    if (!raw) return new Response("no overlap", { status: 204 });
    const body = encodeAligned(reproject(raw, ra, dec, n, scale));
    return new Response(body, {
      headers: { "content-type": "application/octet-stream", "cache-control": "public, max-age=3600" },
    });
  } catch (e: any) {
    return new Response(`cutout failed: ${e?.message ?? e}`, { status: 502 });
  }
};
