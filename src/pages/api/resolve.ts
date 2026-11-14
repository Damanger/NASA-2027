import type { APIRoute } from "astro";
import { TARGETS } from "../../config/targets.ts";

const cache = new Map<string, any>();

/** Name -> coordinates (featured list first, then CDS Sesame). */
export const GET: APIRoute = async ({ url }) => {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return json({ error: "empty query" }, 400);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const local = TARGETS.find((t) => norm(t.name) === norm(q) || t.id === norm(q));
  if (local) return json({ name: local.name, ...local, source: "featured" });
  if (cache.has(norm(q))) return json(cache.get(norm(q)));

  const hosts = [
    // NED answers instantly from cache; SIMBAD/VizieR can be slow, so try them separately.
    "https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/N?",
    "https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/S?",
    "https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/V?",
  ];
  for (const h of hosts) {
    try {
      const r = await fetch(h + encodeURIComponent(q), { signal: AbortSignal.timeout(15_000), redirect: "follow" });
      if (!r.ok) continue;
      const text = await r.text();
      const m = /%J\s+([\d.]+)\s+([+-][\d.]+)/.exec(text);
      if (!m) continue;
      const pm = /%P\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)/.exec(text); // mas/yr
      const name = /#=\w+:.*\n/.exec(text) ? q : q;
      const out = {
        name,
        ra: Number(m[1]),
        dec: Number(m[2]),
        epoch: 2000,
        pmra: pm ? Number(pm[1]) : 0,
        pmdec: pm ? Number(pm[2]) : 0,
        source: "Sesame",
      };
      cache.set(norm(q), out);
      return json(out);
    } catch {
      /* try next */
    }
  }
  return json({ error: `Could not resolve "${q}". Enter RA/Dec directly.` }, 404);
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
