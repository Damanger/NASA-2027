import type { APIRoute } from "astro";

const cache = new Map<string, { t: number; body: any }>();

/**
 * Cone search of overlay catalogues: Gaia DR3 (ESA archive) or AllWISE (IRSA).
 * Returns positions with proper motions so the browser can propagate them to each frame's epoch.
 */
export const GET: APIRoute = async ({ url }) => {
  const q = url.searchParams;
  const ra = Number(q.get("ra"));
  const dec = Number(q.get("dec"));
  const r = Math.min(Number(q.get("r") ?? 0.1), 0.5); // degrees
  const cat = q.get("cat") ?? "gaia";
  if (![ra, dec, r].every(Number.isFinite)) return json({ error: "bad params" }, 400);
  const key = `${cat}|${ra.toFixed(3)}|${dec.toFixed(3)}|${r.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 30 * 60_000) return json(hit.body);
  try {
    let adql: string;
    let endpoint: string;
    if (cat === "gaia") {
      endpoint = "https://gea.esac.esa.int/tap-server/tap/sync";
      adql = `SELECT TOP 800 source_id, ra, dec, pmra, pmdec, phot_g_mean_mag AS mag, parallax FROM gaiadr3.gaia_source WHERE 1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${ra},${dec},${r})) ORDER BY phot_g_mean_mag`;
    } else if (cat === "wise") {
      endpoint = `https://irsa.ipac.caltech.edu/SCS?table=allwise_p3as_psd&RA=${ra}&DEC=${dec}&SR=${r}&RESPONSEFORMAT=csv`;
      adql = "";
    } else return json({ error: "unknown catalogue" }, 400);
    const resp =
      cat === "gaia"
        ? await fetch(endpoint, {
            method: "POST",
            body: new URLSearchParams({ REQUEST: "doQuery", LANG: "ADQL", FORMAT: "csv", QUERY: adql }),
            headers: { "content-type": "application/x-www-form-urlencoded" },
            signal: AbortSignal.timeout(45_000),
          })
        : await fetch(endpoint, { signal: AbortSignal.timeout(45_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const lines = (await resp.text()).trim().split(/\r?\n/);
    const head = lines.shift()!.split(",").map((h) => h.replace(/"/g, ""));
    const rows = lines.map((l) => l.split(",").map((v) => v.replace(/"/g, "")));
    const idx = (k: string) => head.indexOf(cat === "wise" && k === "mag" ? "w2mpro" : k === "source_id" && cat === "wise" ? "designation" : k);
    const num = (v: string | undefined) => (v === undefined || v === "" ? null : Number(v));
    const sources = rows.slice(0, 1500).map((c) => ({
      id: c[idx("source_id")],
      ra: Number(c[idx("ra")]),
      dec: Number(c[idx("dec")]),
      pmra: num(c[idx("pmra")]),
      pmdec: num(c[idx("pmdec")]),
      mag: num(c[idx("mag")]),
      plx: idx("parallax") >= 0 ? num(c[idx("parallax")]) : null,
    }));
    // Gaia positions are at epoch 2016.0; AllWISE at ~2010.56 (ra/dec at MJD 55400 = 2010.56)
    const body2 = { cat, epoch: cat === "gaia" ? 2016.0 : 2010.56, sources };
    cache.set(key, { t: Date.now(), body: body2 });
    return json(body2);
  } catch (e: any) {
    return json({ error: `${cat} query failed: ${e?.message ?? e}` }, 502);
  }
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=600" },
  });
}
