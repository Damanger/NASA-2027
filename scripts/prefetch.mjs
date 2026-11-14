#!/usr/bin/env node
/**
 * Warms the on-disk cutout cache for the featured targets (or for any position) so the
 * first visitor does not wait for IRSA. Uses exactly the same geometry as the browser.
 *
 *   npm run prefetch                       # all featured targets, default settings
 *   npm run prefetch -- barnard rdra       # only some featured targets
 *   npm run prefetch -- --ra 133.79 --dec -7.24 --fov 4 --max 120
 *   npm run prefetch -- --all              # every exposure (slow, 1 request per exposure)
 */
import { TARGETS } from "../src/config/targets.ts";
import { getRawCutout, queryFrames } from "../src/lib/spherex.ts";
import { cutoutSizeDeg, mjdToYear, propagate, selectFrames } from "../src/lib/plan.ts";

const args = process.argv.slice(2);
const flag = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const all = args.includes("--all");
const max = all ? 9999 : Number(flag("max", 72));
const ids = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));

let list = TARGETS;
if (flag("ra")) {
  list = [
    {
      id: "custom",
      name: "custom position",
      ra: Number(flag("ra")),
      dec: Number(flag("dec")),
      epoch: 2000,
      pmra: 0,
      pmdec: 0,
      fov: Number(flag("fov", 4)),
    },
  ];
} else if (ids.length) list = TARGETS.filter((t) => ids.includes(t.id));

for (const t of list) {
  const q0 = propagate(t, 2026.0);
  const frames = await queryFrames(q0.ra, q0.dec);
  const sel = selectFrames(frames, [1, 2, 3, 4, 5, 6], max);
  const years = sel.map((f) => mjdToYear(f.mjd));
  const yMean = years.reduce((a, b) => a + b, 0) / years.length;
  const c = propagate(t, yMean);
  const fov = Number(flag("fov", t.fov));
  const size = cutoutSizeDeg(fov, 0);
  console.log(`\n${t.name}: ${frames.length} exposures cover it, caching ${sel.length} (fov ${fov}′)`);
  let done = 0;
  let empty = 0;
  const t0 = Date.now();
  await Promise.all(
    sel.map(async (f) => {
      try {
        const raw = await getRawCutout(f.url, f, Number(c.ra.toFixed(3)), Number(c.dec.toFixed(3)), size);
        if (!raw) empty++;
      } catch (e) {
        console.warn(`  ! ${f.obsId} D${f.det}: ${e.message}`);
      }
      done++;
      if (done % 8 === 0 || done === sel.length)
        process.stdout.write(`\r  ${done}/${sel.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }),
  );
  console.log(`\n  done${empty ? `, ${empty} outside footprint` : ""}`);
}
