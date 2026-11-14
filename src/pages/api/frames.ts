import type { APIRoute } from "astro";
import { COLLECTIONS } from "../../config/spherex.ts";
import { queryFrames } from "../../lib/spherex.ts";

export const GET: APIRoute = async ({ url }) => {
  const ra = Number(url.searchParams.get("ra"));
  const dec = Number(url.searchParams.get("dec"));
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || Math.abs(dec) > 90)
    return json({ error: "ra and dec (degrees) are required" }, 400);
  try {
    const frames = await queryFrames(ra, dec);
    return json({ ra, dec, collections: COLLECTIONS, frames });
  } catch (e: any) {
    return json({ error: `IRSA query failed: ${e?.message ?? e}` }, 502);
  }
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
}
