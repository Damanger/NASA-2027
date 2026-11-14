import { DETECTORS, FLAG_CATEGORIES, OVERSAMPLE } from "../config/spherex.ts";
import { TARGETS, findTarget } from "../config/targets.ts";
import {
  cutoutSizeDeg,
  frameQuery,
  gridScale,
  gridSize,
  mjdToYear,
  propagate,
  selectFrames,
  type FrameInfo,
  type Position,
} from "../lib/plan.ts";
import { skyToTan, tanToSky } from "../lib/wcs.ts";
import {
  aperture,
  formatFlux,
  percentiles,
  smooth,
  stack,
  subtract,
  subtractBackground,
  toRGBA,
  type CmapName,
  type Img,
  type Photometry,
  type Stretch,
} from "./imaging.ts";
import { Plot, type Series } from "./plot.ts";

/* ------------------------------------------------------------------ types */

interface FrameMeta {
  n: number;
  scale: number;
  wave: number | null;
  bw: number | null;
  wgrad: [number, number] | null;
  det: number;
  obsId: string;
  mjd: number;
  exptime: number;
  coverage: number;
  centerFlags: number;
  quality: Record<string, string | number | boolean | null>;
}
interface Loaded {
  f: FrameInfo;
  info: FrameMeta;
  img: Img;
  flags: Uint16Array;
  bg?: Img;
  masked?: Img;
  phot?: Photometry;
  /** reprojection centre actually used */
  centre: { ra: number; dec: number };
}
interface Item {
  frames: Loaded[];
  img: Img;
  label: string;
  sub: string;
  year: number;
  centre: { ra: number; dec: number };
}
interface CatSource {
  id: string;
  ra: number;
  dec: number;
  pmra: number | null;
  pmdec: number | null;
  mag: number | null;
}

/* ---------------------------------------------------------------- helpers */

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (id: string) => Number(($(id) as HTMLInputElement).value);
const val = (id: string) => ($(id) as HTMLInputElement).value;
const chk = (id: string) => ($(id) as HTMLInputElement).checked;
const setChk = (id: string, v: boolean) => (($(id) as HTMLInputElement).checked = v);
const setVal = (id: string, v: string | number) => (($(id) as HTMLInputElement).value = String(v));

function parseAngle(raw: string, isRa: boolean): number | null {
  let s = raw.trim().replace(/−/g, "-").replace(/,/g, " ");
  if (!s) return null;
  if (/^[+-]?\d+(\.\d*)?$/.test(s) || /^[+-]?\.\d+$/.test(s)) return Number(s);
  const neg = /^-/.test(s) || /^[^\d]*-/.test(s);
  const nums = s.match(/\d+(\.\d+)?/g)?.map(Number);
  if (!nums?.length || nums.length > 3) return null;
  const [a, b = 0, c = 0] = nums;
  let v = a + b / 60 + c / 3600;
  if (isRa && !/[d°]/i.test(s)) v *= 15;
  return neg ? -v : v;
}

function splitCombined(s: string): [string, string] | null {
  const m = /^\s*(.+?)[\s,;]+([+\-−]\s*.+)$/.exec(s.trim());
  if (m) return [m[1], m[2].replace(/\s+/g, "")];
  const parts = s.trim().split(/[\s,;]+/);
  if (parts.length === 2 && /^[+-]?\d/.test(parts[1])) return [parts[0], parts[1]];
  return null;
}

const fmtRa = (deg: number) => {
  const h = (((deg % 360) + 360) % 360) / 15;
  const hh = Math.floor(h);
  const m = Math.floor((h - hh) * 60);
  const s = ((h - hh) * 60 - m) * 60;
  return `${String(hh).padStart(2, "0")}h${String(m).padStart(2, "0")}m${s.toFixed(1).padStart(4, "0")}s`;
};
const fmtDec = (deg: number) => {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const s = ((a - d) * 60 - m) * 60;
  return `${deg < 0 ? "−" : "+"}${String(d).padStart(2, "0")}°${String(m).padStart(2, "0")}′${s.toFixed(0).padStart(2, "0")}″`;
};
const mjdToUtc = (mjd: number) => new Date((mjd - 40587) * 86400000).toISOString().slice(0, 16).replace("T", " ");
const mjdToDay = (mjd: number) => new Date((mjd - 40587) * 86400000).toISOString().slice(0, 10);

const flagColor = (c: (typeof FLAG_CATEGORIES)[number]) => (c.soft ? "#ffb454" : c.bad ? "#ff6b8b" : "#6aa7ff");
function flagChips(mask: number, onlyBad = false) {
  return FLAG_CATEGORIES.map((c, i) => ({ c, on: (mask >> i) & 1 }))
    .filter((x) => x.on && (!onlyBad || x.c.bad))
    .map((x) => `<span class="fl flag" style="--fc:${flagColor(x.c)}" title="${x.c.hint}${x.c.soft ? " (kept unless strict masking is on)" : ""}">${x.c.label}</span>`)
    .join("");
}
/** category bits that only get masked in strict mode */
const SOFT_MASK = FLAG_CATEGORIES.reduce((m, c, i) => (c.soft ? m | (1 << i) : m), 0);

/* ------------------------------------------------------------------ state */

const S = {
  target: { name: "", ra: NaN, dec: NaN, epoch: 2000, pmra: 0, pmdec: 0 } as Position & { name: string },
  presetId: "" as string,
  all: [] as FrameInfo[],
  selected: [] as FrameInfo[],
  loaded: new Map<string, Loaded>(),
  excluded: new Set<string>(),
  missing: 0,
  failed: 0,
  token: 0,
  center: { ra: NaN, dec: NaN },
  n: 100,
  fovArcmin: 4,
  items: [] as Item[],
  cur: 0,
  playing: false,
  lastTick: 0,
  ap: { x: 49.5, y: 49.5 },
  cats: {} as Record<string, { epoch: number; sources: CatSource[] } | undefined>,
  catsKey: "",
  smoothCache: new Map<string, Img>(),
  lockedRange: null as [number, number] | null,
  loadingDone: true,
  startedAt: 0,
};

const cv = $("cv") as HTMLCanvasElement;
const ov = $("ov") as HTMLCanvasElement;
const off = document.createElement("canvas");
const ctx = cv.getContext("2d")!;
const octx = ov.getContext("2d")!;

const specPlot = new Plot($("plot-spec") as HTMLCanvasElement, {
  xLabel: "Wavelength (µm)",
  yLabel: "Flux density",
  xFmt: (v) => v.toFixed(2),
  onPick: (id) => goToFrame(id),
  tip: (p, s) => {
    const l = activeFrames()[p.id];
    return `${s.label} · ${p.x.toFixed(3)} µm\n${p.y.toPrecision(3)} ± ${(p.e ?? 0).toPrecision(2)}\n${l ? mjdToUtc(l.info.mjd) : ""}`;
  },
});
const curvePlot = new Plot($("plot-curve") as HTMLCanvasElement, {
  xLabel: "Date (UTC)",
  yLabel: "Flux density",
  xFmt: (v) => mjdToDay(v),
  onPick: (id) => goToFrame(id),
  tip: (p, s) => `${s.label}\n${mjdToUtc(p.x)}\n${p.y.toPrecision(3)} ± ${(p.e ?? 0).toPrecision(2)}`,
});

/** tells ui.ts which screen to show: idle | loading | ready | nodata | error */
function phase(p: "idle" | "loading" | "ready" | "nodata" | "error") {
  document.body.dataset.phase = p;
  document.dispatchEvent(new CustomEvent("spx:phase", { detail: { phase: p } }));
}

/* ----------------------------------------------------------- status & URL */

function status(msg: string, err = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("err", err);
}

const URL_KEYS: [string, string, (v: string) => void][] = [];
function syncUrl() {
  const q = new URLSearchParams();
  if (S.presetId) q.set("t", S.presetId);
  if (Number.isFinite(S.target.ra)) {
    q.set("ra", S.target.ra.toFixed(6));
    q.set("dec", S.target.dec.toFixed(6));
    if (S.target.name) q.set("name", S.target.name);
    if (S.target.pmra || S.target.pmdec) {
      q.set("pmra", String(S.target.pmra));
      q.set("pmdec", String(S.target.pmdec));
      q.set("epoch", String(S.target.epoch));
    }
  }
  q.set("fov", String(num("in-fov")));
  const dets = detsChecked();
  if (dets.length !== 6) q.set("dets", dets.join(","));
  const add = (k: string, id: string, def: string) => val(id) !== def && q.set(k, val(id));
  add("max", "in-max", "72");
  add("mode", "in-mode", "frames");
  add("diff", "in-diff", "none");
  add("comb", "in-comb", "mean");
  add("smooth", "in-smooth", "0");
  add("stretch", "in-stretch", "asinh");
  add("cmap", "in-cmap", "invert");
  add("hi", "in-hi", "99.8");
  add("lo", "in-lo", "2");
  add("gap", "in-gap", "5");
  add("ap", "in-ap", "12");
  add("mask", "in-mask", "standard");
  if (chk("in-track")) q.set("track", "1");
  if (!chk("in-bg")) q.set("bg", "0");
  if (chk("in-lock")) q.set("lock", "1");
  if (chk("in-pixel")) q.set("pixels", "1");
  if (chk("in-masked")) q.set("masked", "1");
  if (!chk("ov-gaia")) q.set("gaia", "0");
  if (chk("ov-wise")) q.set("wise", "1");
  if (document.body.classList.contains("embed")) q.set("embed", "1");
  history.replaceState(null, "", `?${q.toString()}`);
  ($("link-aladin") as HTMLAnchorElement).href = Number.isFinite(S.target.ra)
    ? `https://aladin.cds.unistra.fr/AladinLite/?target=${S.center.ra.toFixed(5)}+${S.center.dec.toFixed(5)}&fov=${(S.fovArcmin / 60).toFixed(4)}&survey=P%2FDSS2%2Fcolor`
    : "#";
}

function readUrl(): boolean {
  const q = new URLSearchParams(location.search);
  if (q.get("embed")) document.body.classList.add("embed");
  // allow any ?max=N, not only the preset choices
  const mx = Number(q.get("max"));
  const sel = $("in-max") as HTMLSelectElement;
  if (mx > 0 && ![...sel.options].some((o) => Number(o.value) === mx))
    sel.add(new Option(String(mx), String(mx)), 0);
  const set = (k: string, id: string) => q.has(k) && setVal(id, q.get(k)!);
  ["max", "mode", "diff", "comb", "smooth", "stretch", "cmap", "hi", "lo", "gap", "ap", "fov", "mask"].forEach((k) =>
    set(k, `in-${k}`),
  );
  if (q.has("track")) setChk("in-track", q.get("track") === "1");
  if (q.has("bg")) setChk("in-bg", q.get("bg") !== "0");
  setChk("in-lock", q.get("lock") === "1");
  setChk("in-pixel", q.get("pixels") === "1");
  setChk("in-masked", q.get("masked") === "1");
  if (q.has("gaia")) setChk("ov-gaia", q.get("gaia") !== "0");
  setChk("ov-wise", q.get("wise") === "1");
  if (q.has("dets")) {
    const on = q.get("dets")!.split(",").map(Number);
    document.querySelectorAll<HTMLInputElement>("[data-det]").forEach((i) => (i.checked = on.includes(Number(i.dataset.det))));
  }
  const t = q.get("t") ? findTarget(q.get("t")!) : undefined;
  if (t) {
    applyTarget(t, false);
    return true;
  }
  if (q.has("ra") && q.has("dec")) {
    setVal("in-ra", q.get("ra")!);
    setVal("in-dec", q.get("dec")!);
    setVal("in-name", q.get("name") ?? "");
    setVal("in-pmra", q.get("pmra") ?? 0);
    setVal("in-pmdec", q.get("pmdec") ?? 0);
    setVal("in-epoch", q.get("epoch") ?? 2000);
    return true;
  }
  return false;
}
void URL_KEYS;

/* ---------------------------------------------------------------- targets */

function applyTarget(t: (typeof TARGETS)[number], run = true) {
  S.presetId = t.id;
  setVal("in-name", t.name);
  setVal("in-ra", t.ra.toFixed(6));
  setVal("in-dec", t.dec.toFixed(6));
  setVal("in-pmra", t.pmra);
  setVal("in-pmdec", t.pmdec);
  setVal("in-epoch", t.epoch);
  setVal("in-fov", new URLSearchParams(location.search).get("fov") && !run ? val("in-fov") : t.fov);
  $("out-fov").textContent = `${val("in-fov")}′`;
  if (!new URLSearchParams(location.search).has("ap") || run) {
    setVal("in-ap", t.ap ?? 12);
    $("out-ap").textContent = `${t.ap ?? 12}″`;
  }
  document.querySelectorAll("[data-target]").forEach((c) => c.classList.toggle("on", (c as HTMLElement).dataset.target === t.id));
  if (run) void load();
}

function readTargetFromForm(): boolean {
  let raS = val("in-ra");
  let decS = val("in-dec");
  if (raS && !decS) {
    const sp = splitCombined(raS);
    if (sp) {
      [raS, decS] = sp;
      setVal("in-ra", raS);
      setVal("in-dec", decS);
    }
  }
  const ra = parseAngle(raS, true);
  const dec = parseAngle(decS, false);
  if (ra === null || dec === null || Math.abs(dec) > 90) {
    status("Enter a valid RA and Dec (e.g. 08h55m10.831s and −7d14m42.53s, or decimal degrees).", true);
    return false;
  }
  S.target = {
    name: val("in-name").trim(),
    ra: ((ra % 360) + 360) % 360,
    dec,
    epoch: num("in-epoch") || 2000,
    pmra: num("in-pmra") || 0,
    pmdec: num("in-pmdec") || 0,
  };
  return true;
}

/* ---------------------------------------------------------------- loading */

const detsChecked = () =>
  [...document.querySelectorAll<HTMLInputElement>("[data-det]")].filter((i) => i.checked).map((i) => Number(i.dataset.det));

const tracking = () => chk("in-track") && (S.target.pmra !== 0 || S.target.pmdec !== 0);
const hasPm = () => S.target.pmra !== 0 || S.target.pmdec !== 0;

async function load() {
  if (!readTargetFromForm()) return;
  const token = ++S.token;
  phase("loading");
  S.playing = false;
  updatePlayBtn();
  S.loaded = new Map();
  S.excluded = new Set();
  S.items = [];
  S.missing = 0;
  S.failed = 0;
  S.cats = {};
  S.catsKey = "";
  S.fovArcmin = num("in-fov");
  $("empty").hidden = true;
  $("loading").hidden = false;
  $("bar").style.width = "0%";
  $("loading-text").textContent = "Searching the SPHEREx archive…";
  $("hud-label").textContent = "Searching…";
  status("");
  syncUrl();

  // 1. which snapshots cover this position?
  const q0 = hasPm() ? propagate(S.target, 2026.0) : { ra: S.target.ra, dec: S.target.dec };
  let frames: FrameInfo[];
  try {
    const r = await fetch(`/api/frames?ra=${q0.ra}&dec=${q0.dec}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? r.statusText);
    frames = j.frames;
  } catch (e: any) {
    if (token !== S.token) return;
    $("loading").hidden = true;
    status(`Could not reach the archive: ${e.message}`, true);
    phase("error");
    return;
  }
  if (token !== S.token) return;
  S.all = frames;
  const perDet = new Map<number, number>();
  frames.forEach((f) => perDet.set(f.det, (perDet.get(f.det) ?? 0) + 1));
  document.querySelectorAll<HTMLElement>("[data-detn]").forEach((el) => {
    el.textContent = String(perDet.get(Number(el.dataset.detn)) ?? 0);
  });
  if (!frames.length) {
    $("loading").hidden = true;
    status("No SPHEREx snapshots cover this position in the available releases yet. New data arrive weekly, so try again soon or pick another spot.", true);
    phase("nodata");
    return;
  }

  // 2. choose a balanced subset and plan the geometry
  const dets = detsChecked();
  const selected = selectFrames(frames, dets, num("in-max") || 72);
  S.selected = selected;
  if (!selected.length) {
    $("loading").hidden = true;
    status("No snapshots for the colour bands you selected. Turn some on and try again.", true);
    phase("nodata");
    return;
  }
  const years = selected.map((f) => mjdToYear(f.mjd));
  const yMean = years.reduce((a, b) => a + b, 0) / years.length;
  const span = Math.max(...years) - Math.min(...years);
  S.center = hasPm() ? propagate(S.target, yMean) : { ra: S.target.ra, dec: S.target.dec };
  S.n = gridSize(S.fovArcmin);
  S.ap = { x: (S.n - 1) / 2, y: (S.n - 1) / 2 };
  const pmTotal = Math.hypot(S.target.pmra, S.target.pmdec); // mas/yr
  const margin = tracking() ? (pmTotal * (span / 2 + 0.05)) / 3.6e6 : 0;
  const size = cutoutSizeDeg(S.fovArcmin, margin);
  const total = selected.length;
  status(`${frames.length} snapshots cover this spot; loading ${total}.`);
  syncUrl();
  S.loadingDone = false;
  S.startedAt = performance.now();
  refreshCatalogs();

  // 3. download aligned frames with a small worker pool
  let next = 0;
  let done = 0;
  const WORKERS = 8;
  const refreshSoon = throttle(() => {
    if (token !== S.token) return;
    rebuild(true);
  }, 400);

  const worker = async () => {
    while (token === S.token) {
      const i = next++;
      if (i >= total) return;
      const f = selected[i];
      const centre = tracking() ? propagate(S.target, mjdToYear(f.mjd)) : S.center;
      const qs = frameQuery(f, { ra: centre.ra, dec: centre.dec, cra: S.center.ra, cdec: S.center.dec, size, n: S.n });
      try {
        let resp = await fetch(`/api/frame?${qs}`);
        if (resp.status >= 500) {
          await new Promise((r) => setTimeout(r, 1200));
          resp = await fetch(`/api/frame?${qs}`);
        }
        if (token !== S.token) return;
        if (resp.status === 204) S.missing++;
        else if (!resp.ok) S.failed++;
        else {
          const buf = await resp.arrayBuffer();
          const len = new DataView(buf).getUint32(0, true);
          const info = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, len))) as FrameMeta;
          const n = info.n;
          const img = new Float32Array(buf.slice(4 + len, 4 + len + n * n * 4));
          const flags = new Uint16Array(buf.slice(4 + len + n * n * 4, 4 + len + n * n * 6));
          S.loaded.set(f.url, { f, info, img, flags, centre });
        }
      } catch {
        S.failed++;
      }
      done++;
      const el = (performance.now() - S.startedAt) / 1000;
      const eta = done ? (el / done) * (total - done) : 0;
      $("bar").style.width = `${(done / total) * 100}%`;
      $("loading-text").textContent = `Loaded ${S.loaded.size} of ${total} snapshots${
        S.missing ? ` · ${S.missing} outside footprint` : ""
      }${S.failed ? ` · ${S.failed} failed` : ""}${done < total ? ` · about ${fmtDur(eta)} left (first visit is slowest; results are cached)` : ""}`;
      refreshSoon();
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, total) }, worker));
  if (token !== S.token) return;
  S.loadingDone = true;
  $("loading").hidden = true;
  rebuild(false);
  if (!S.loaded.size) {
    status("None of the snapshots produced a usable image here. Try a larger view.", true);
    phase("nodata");
  } else {
    phase("ready");
    status(
      `${S.loaded.size} snapshots aligned${S.missing ? ` (${S.missing} did not overlap the field)` : ""}${S.failed ? `, ${S.failed} failed to download` : ""}.`,
    );
    if (!S.playing && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      S.playing = true;
      updatePlayBtn();
    }
  }
}

function fmtDur(s: number) {
  if (!Number.isFinite(s)) return "…";
  return s >= 90 ? `${Math.round(s / 60)} min` : `${Math.max(1, Math.round(s))} s`;
}

function throttle<F extends (...a: any[]) => void>(fn: F, ms: number) {
  let t = 0;
  let pending = false;
  return ((...a: any[]) => {
    const now = performance.now();
    if (now - t >= ms) {
      t = now;
      fn(...a);
    } else if (!pending) {
      pending = true;
      setTimeout(() => {
        pending = false;
        t = performance.now();
        fn(...a);
      }, ms - (now - t));
    }
  }) as F;
}

/* --------------------------------------------------------------- catalogs */

async function refreshCatalogs() {
  if (!Number.isFinite(S.center.ra)) return;
  const want: ("gaia" | "wise")[] = [];
  if (chk("ov-gaia")) want.push("gaia");
  if (chk("ov-wise")) want.push("wise");
  const r = Math.min(0.5, (S.fovArcmin / 60) * 0.75 + 0.03 + (tracking() ? 0.02 : 0));
  for (const cat of want) {
    const key = `${cat}|${S.center.ra.toFixed(3)}|${S.center.dec.toFixed(3)}|${r.toFixed(3)}`;
    if (S.catsKey.includes(key)) continue;
    S.catsKey += key + ";";
    try {
      const resp = await fetch(`/api/catalog?cat=${cat}&ra=${S.center.ra}&dec=${S.center.dec}&r=${r}`);
      const j = await resp.json();
      if (resp.ok) {
        S.cats[cat] = j;
        draw();
      }
    } catch {
      /* overlays are optional */
    }
  }
}

/* ------------------------------------------------------- build the images */

const activeFrames = (): Loaded[] => {
  const dets = detsChecked();
  return [...S.loaded.values()]
    .filter((l) => dets.includes(l.info.det) && !S.excluded.has(l.f.url))
    .sort((a, b) => a.info.mjd - b.info.mjd);
};

/** image with the optional strict (soft-flag) mask applied */
const base = (l: Loaded): Img => {
  if (val("in-mask") !== "strict") return l.img;
  if (!l.masked) {
    const m = new Float32Array(l.img);
    for (let i = 0; i < m.length; i++) if (l.flags[i] & SOFT_MASK) m[i] = NaN;
    l.masked = m;
  }
  return l.masked;
};
const pre = (l: Loaded): Img => {
  if (!chk("in-bg")) return base(l);
  return (l.bg ??= subtractBackground(base(l)));
};
const resetMaskCaches = () => S.loaded.forEach((l) => ((l.bg = undefined), (l.masked = undefined)));

function meanWave(fr: Loaded[]) {
  const w = fr.map((l) => l.info.wave).filter((x): x is number => x !== null);
  return w.length ? w.reduce((a, b) => a + b, 0) / w.length : null;
}

function rebuild(keepFrame: boolean) {
  const prevCur = S.cur;
  const prevKey = S.items[S.cur]?.frames[0]?.f.url;
  const list = activeFrames();
  const mode = val("in-mode");
  const comb = val("in-comb") as "mean" | "median";
  const centreFor = (fr: Loaded[]) => (tracking() ? fr[Math.floor(fr.length / 2)].centre : S.center);
  const yearOf = (fr: Loaded[]) => fr.reduce((a, l) => a + mjdToYear(l.info.mjd), 0) / fr.length;
  let items: Item[] = [];

  if (mode === "frames") {
    items = list.map((l) => {
      const w = l.info.wave;
      return {
        frames: [l],
        img: pre(l),
        label: `D${l.info.det} · ${w ? w.toFixed(2) + " µm" : "—"} · ${mjdToUtc(l.info.mjd)} UTC`,
        sub: l.info.obsId,
        year: mjdToYear(l.info.mjd),
        centre: l.centre,
      };
    });
  } else if (mode === "detector") {
    const by = new Map<number, Loaded[]>();
    list.forEach((l) => by.set(l.info.det, [...(by.get(l.info.det) ?? []), l]));
    items = [...by.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([d, fr]) => {
        const w = meanWave(fr);
        return {
          frames: fr,
          img: stack(fr.map(pre), comb),
          label: `D${d} sum · ${DETECTORS[d].min}–${DETECTORS[d].max} µm · ${fr.length} snapshots`,
          sub: `${mjdToDay(fr[0].info.mjd)} → ${mjdToDay(fr[fr.length - 1].info.mjd)}${w ? ` · mean ${w.toFixed(2)} µm` : ""}`,
          year: yearOf(fr),
          centre: centreFor(fr),
        };
      });
  } else {
    const gap = num("in-gap");
    const groups: Loaded[][] = [];
    for (const l of list) {
      const g = groups[groups.length - 1];
      if (g && l.info.mjd - g[g.length - 1].info.mjd <= gap) g.push(l);
      else groups.push([l]);
    }
    items = groups.map((fr, i) => ({
      frames: fr,
      img: stack(fr.map(pre), comb),
      label: `Visit ${i + 1} · ${mjdToDay(fr[0].info.mjd)}${fr.length > 1 ? " → " + mjdToDay(fr[fr.length - 1].info.mjd) : ""} · ${fr.length} snapshots`,
      sub: [...new Set(fr.map((l) => "D" + l.info.det))].join(" "),
      year: yearOf(fr),
      centre: centreFor(fr),
    }));
  }

  // differences
  const diff = val("in-diff");
  if (diff !== "none" && items.length > 1) {
    if (diff === "median") {
      const groupKey = (it: Item) => (mode === "frames" ? it.frames[0].info.det : 0);
      const groups = new Map<number, Item[]>();
      items.forEach((it) => groups.set(groupKey(it), [...(groups.get(groupKey(it)) ?? []), it]));
      const refs = new Map<number, Img>();
      groups.forEach((g, k) => refs.set(k, stack((g.length >= 3 ? g : items).map((x) => x.img), "median")));
      items = items.map((it) => ({ ...it, img: subtract(it.img, refs.get(groupKey(it))!), sub: `${it.sub} · minus median` }));
    } else if (diff === "prev") {
      items = items.slice(1).map((it, i) => ({ ...it, img: subtract(it.img, items[i].img), sub: `${it.sub} · minus previous` }));
    } else {
      const first = items[0];
      items = items.slice(1).map((it) => ({ ...it, img: subtract(it.img, first.img), sub: `${it.sub} · minus first` }));
    }
  }

  S.items = items;
  S.smoothCache.clear();
  S.lockedRange = null;
  if (keepFrame && prevKey) {
    const idx = items.findIndex((it) => it.frames[0].f.url === prevKey);
    S.cur = idx >= 0 ? idx : Math.min(prevCur, Math.max(0, items.length - 1));
  } else S.cur = Math.min(S.cur, Math.max(0, items.length - 1));
  const slider = $("in-frame") as HTMLInputElement;
  slider.max = String(Math.max(0, items.length - 1));
  slider.value = String(S.cur);
  $("empty").hidden = items.length > 0 || !S.loadingDone;
  measure();
  renderTable();
  draw();
}

/* ---------------------------------------------------------------- drawing */

function displayImage(it: Item, idx: number): Img {
  const sigma = num("in-smooth");
  if (sigma <= 0) return it.img;
  const k = `${idx}|${sigma}`;
  let v = S.smoothCache.get(k);
  if (!v) {
    v = smooth(it.img, S.n, sigma);
    S.smoothCache.set(k, v);
  }
  return v;
}

function range(img: Img): [number, number] {
  const diff = val("in-diff") !== "none";
  const hiP = num("in-hi");
  const loP = num("in-lo");
  if (diff) {
    const [a, b] = percentiles(img, [100 - hiP + 0.2, hiP]);
    const m = Math.max(Math.abs(a), Math.abs(b), 1e-9);
    return [-m, m];
  }
  const [lo, hi] = percentiles(img, [loP, hiP]);
  return hi > lo ? [lo, hi] : [lo, lo + 1e-6];
}

function currentRange(img: Img): [number, number] {
  if (!chk("in-lock")) return range(img);
  if (!S.lockedRange) {
    const rs = S.items.map((it, i) => range(displayImage(it, i)));
    const lo = Math.min(...rs.map((r) => r[0]));
    const hi = Math.max(...rs.map((r) => r[1]));
    S.lockedRange = [lo, hi];
  }
  return S.lockedRange;
}

function fitCanvas() {
  const r = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(50, Math.round(r.width * dpr));
  if (cv.width !== w || cv.height !== w) {
    cv.width = ov.width = w;
    cv.height = ov.height = w;
  }
  return { w, dpr };
}

function itemEpochCentre(it: Item) {
  return it.centre;
}

function toPix(c: { ra: number; dec: number }, ra: number, dec: number): [number, number] {
  const [xi, eta] = skyToTan(c.ra, c.dec, ra, dec);
  const s = gridScale / 3600;
  const half = (S.n - 1) / 2;
  return [half - xi / s, half - eta / s];
}

function draw() {
  const { w, dpr } = fitCanvas();
  const it = S.items[S.cur];
  ctx.fillStyle = "#02040a";
  ctx.fillRect(0, 0, w, w);
  octx.clearRect(0, 0, w, w);
  const label = $("hud-label");
  if (!it) {
    if (S.loadingDone && Number.isFinite(S.center.ra)) label.textContent = S.loaded.size ? "No images match the current selection" : "";
    $("hud-flags").innerHTML = "";
    return;
  }
  const img = displayImage(it, S.cur);
  const [lo, hi] = currentRange(img);
  off.width = off.height = S.n;
  const octx2 = off.getContext("2d")!;
  octx2.putImageData(
    toRGBA(img, S.n, {
      lo,
      hi,
      stretch: val("in-stretch") as Stretch,
      cmap: val("in-cmap") as CmapName,
      showMasked: chk("in-masked"),
    }),
    0,
    0,
  );
  ctx.imageSmoothingEnabled = !chk("in-pixel");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(off, 0, 0, w, w);

  label.innerHTML = `<b>${it.label}</b><br><span style="opacity:.75">${it.sub}</span>`;
  const mask = it.frames.reduce((m, l) => m | l.info.centerFlags, 0);
  const qa = it.frames.filter((l) => l.info.quality.L2DQAFLG && l.info.quality.L2DQAFLG !== "Pass").length;
  $("hud-flags").innerHTML =
    flagChips(mask, false) + (qa ? `<span class="flag" style="--fc:#ff6b8b">QA ≠ pass ×${qa}</span>` : "");
  $("frame-count").textContent = `${S.cur + 1} / ${S.items.length}`;
  ($("in-frame") as HTMLInputElement).value = String(S.cur);
  curvePlot.setCursor(cursorId());
  specPlot.setCursor(cursorId());
  document.querySelectorAll("#tbody tr.cur").forEach((r) => r.classList.remove("cur"));
  const urls = new Set(it.frames.map((l) => l.f.url));
  document.querySelectorAll<HTMLElement>("#tbody tr").forEach((r) => r.classList.toggle("cur", urls.has(r.dataset.url ?? "")));

  drawOverlay(it, w, dpr);
}

const cursorId = () => {
  const it = S.items[S.cur];
  if (!it) return null;
  const list = activeFrames();
  return list.findIndex((l) => l === it.frames[0]);
};

function drawOverlay(it: Item, w: number, dpr: number) {
  const k = w / S.n;
  const c = itemEpochCentre(it);
  const px = (i: number, j: number): [number, number] => [(i + 0.5) * k, (j + 0.5) * k];
  octx.lineWidth = 1.5 * dpr;
  octx.font = `${11 * dpr}px ui-monospace, monospace`;

  // catalogues
  const drawCat = (cat: "gaia" | "wise", color: string, square: boolean) => {
    const data = S.cats[cat];
    if (!data || !chk(cat === "gaia" ? "ov-gaia" : "ov-wise")) return;
    octx.strokeStyle = color;
    for (const s of data.sources) {
      const p = propagate({ ra: s.ra, dec: s.dec, epoch: data.epoch, pmra: s.pmra ?? 0, pmdec: s.pmdec ?? 0 }, it.year);
      const [i, j] = toPix(c, p.ra, p.dec);
      if (i < -2 || j < -2 || i > S.n + 1 || j > S.n + 1) continue;
      const [x, y] = px(i, j);
      const mag = s.mag ?? 18;
      const r = (square ? 7 : 5 + Math.max(0, Math.min(8, (18 - mag) * 0.8))) * dpr;
      octx.beginPath();
      if (square) octx.rect(x - r, y - r, 2 * r, 2 * r);
      else octx.arc(x, y, r, 0, Math.PI * 2);
      octx.stroke();
    }
  };
  drawCat("gaia", "rgba(79,209,255,.9)", false);
  drawCat("wise", "rgba(255,123,213,.9)", true);

  // predicted target position at this epoch
  if (chk("ov-pred") && Number.isFinite(S.target.ra)) {
    const p = propagate(S.target, it.year);
    const [i, j] = toPix(c, p.ra, p.dec);
    const [x, y] = px(i, j);
    octx.strokeStyle = "#ffb454";
    octx.lineWidth = 2 * dpr;
    const r = 11 * dpr;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      octx.beginPath();
      octx.moveTo(x + dx * r * 0.55, y + dy * r * 0.55);
      octx.lineTo(x + dx * r * 1.7, y + dy * r * 1.7);
      octx.stroke();
    }
  }

  // aperture
  if (chk("ov-ap")) {
    const [x, y] = px(S.ap.x, S.ap.y);
    octx.strokeStyle = "#9bff9b";
    octx.setLineDash([5 * dpr, 4 * dpr]);
    octx.lineWidth = 1.5 * dpr;
    octx.beginPath();
    octx.arc(x, y, (num("in-ap") / gridScale) * k, 0, Math.PI * 2);
    octx.stroke();
    octx.setLineDash([]);
  }

  // compass + scale bar
  octx.fillStyle = octx.strokeStyle = "rgba(230,235,248,.85)";
  octx.lineWidth = 1.5 * dpr;
  const cx = 40 * dpr;
  const cy = w - 46 * dpr;
  const L = 22 * dpr;
  octx.beginPath();
  octx.moveTo(cx, cy);
  octx.lineTo(cx, cy - L);
  octx.moveTo(cx, cy);
  octx.lineTo(cx - L, cy);
  octx.stroke();
  octx.fillText("N", cx - 4 * dpr, cy - L - 4 * dpr);
  octx.fillText("E", cx - L - 14 * dpr, cy + 4 * dpr);
  const barArc = S.fovArcmin >= 6 ? 120 : S.fovArcmin >= 2.5 ? 60 : 30;
  const barPx = (barArc / gridScale) * k;
  octx.fillStyle = octx.strokeStyle = "rgba(230,235,248,.85)";
  octx.beginPath();
  octx.moveTo(w - 16 * dpr - barPx, w - 20 * dpr);
  octx.lineTo(w - 16 * dpr, w - 20 * dpr);
  octx.stroke();
  octx.textAlign = "right";
  octx.fillText(barArc >= 60 ? `${barArc / 60}′` : `${barArc}″`, w - 16 * dpr, w - 26 * dpr);
  octx.textAlign = "left";
}

/* ---------------------------------------------------------------- measure */

function measure() {
  const rAp = num("in-ap");
  for (const l of S.loaded.values()) l.phot = aperture(base(l), S.n, S.ap.x, S.ap.y, gridScale, rAp, OVERSAMPLE);
  renderPlots();
}

function waveAtAp(l: Loaded): number | null {
  const w = l.info.wave;
  if (w === null) return null;
  const g = l.info.wgrad;
  if (!g) return w;
  const half = (S.n - 1) / 2;
  return w + g[0] * (S.ap.x - half) + g[1] * (S.ap.y - half);
}

function renderPlots() {
  const frames = activeFrames();
  const ok = frames.map((l, i) => ({ l, i })).filter((x) => x.l.phot && Number.isFinite(x.l.phot.flux));
  $("meas-note").textContent = frames.length
    ? `${ok.length} of ${frames.length} snapshots measurable here.${ok.length < frames.length * 0.7 ? " Saturated or masked pixels can't be measured: SPHEREx blanks the cores of very bright stars, so try a larger measuring circle." : ""}`
    : "";
  if (!ok.length) {
    specPlot.setData([]);
    curvePlot.setData([]);
    specPlot.setEmpty(S.loaded.size ? "No usable measurement at this position" : "Load a target to see its spectrum");
    curvePlot.setEmpty(S.loaded.size ? "No usable measurement at this position" : "Load a target to see its light curve");
    return;
  }
  const typical = [...ok].map((x) => Math.abs(x.l.phot!.flux)).sort((a, b) => a - b)[Math.floor(ok.length / 2)];
  const { unit } = formatFlux(typical);
  const sc = unit === "Jy" ? 1 : unit === "mJy" ? 1e3 : 1e6;
  const dets = [...new Set(ok.map((x) => x.l.info.det))].sort();
  const spec: Series[] = [];
  const curveDet = Number(val("in-curve-det"));
  const curve: Series[] = [];
  for (const d of dets) {
    const mine = ok.filter((x) => x.l.info.det === d);
    const col = DETECTORS[d].color;
    spec.push({
      label: `D${d}`,
      color: col,
      pts: mine
        .map((x) => ({ x: waveAtAp(x.l) ?? NaN, y: x.l.phot!.flux * sc, e: x.l.phot!.err * sc, id: x.i }))
        .filter((p) => Number.isFinite(p.x))
        .sort((a, b) => a.x - b.x),
    });
    if (!curveDet || curveDet === d)
      curve.push({
        label: `D${d} (${DETECTORS[d].min}–${DETECTORS[d].max} µm)`,
        color: col,
        line: true,
        pts: mine.map((x) => ({ x: x.l.info.mjd, y: x.l.phot!.flux * sc, e: x.l.phot!.err * sc, id: x.i })),
      });
  }
  (specPlot as any).o.yLabel = `Flux density (${unit})`;
  (curvePlot as any).o.yLabel = `Flux density (${unit})`;
  specPlot.setData(spec);
  curvePlot.setData(curve);
  specPlot.setCursor(cursorId());
  curvePlot.setCursor(cursorId());
  // keep the detector dropdown in step with what is available
  const sel = $("in-curve-det") as HTMLSelectElement;
  const have = [...sel.options].map((o) => o.value).join();
  const want = ["0", ...dets.map(String)].join();
  if (have !== want) {
    const keep = sel.value;
    sel.innerHTML = `<option value="0">All detectors</option>` + dets.map((d) => `<option value="${d}">D${d}</option>`).join("");
    sel.value = want.split(",").includes(keep) ? keep : "0";
  }
}

function goToFrame(listIdx: number) {
  const target = activeFrames()[listIdx];
  if (!target) return;
  const i = S.items.findIndex((it) => it.frames.includes(target));
  if (i >= 0) {
    S.cur = i;
    S.playing = false;
    updatePlayBtn();
    draw();
  }
}

/* ------------------------------------------------------------------ table */

function renderTable() {
  const rows = [...S.loaded.values()].sort((a, b) => a.info.mjd - b.info.mjd);
  const html = rows
    .map((l, i) => {
      const off = S.excluded.has(l.f.url);
      const col = DETECTORS[l.info.det]?.color ?? "#888";
      const qa = String(l.info.quality.L2DQAFLG ?? "—");
      return `<tr data-url="${l.f.url}" class="${off ? "off" : ""}">
        <td><input type="checkbox" data-ex="${l.f.url}" ${off ? "" : "checked"} aria-label="Include snapshot ${i + 1}"></td>
        <td>${i + 1}</td><td>${mjdToUtc(l.info.mjd)}</td>
        <td><span class="dot" style="--c:${col}"></span>D${l.info.det}</td>
        <td>${l.info.wave ? l.info.wave.toFixed(3) : "—"}</td><td>${l.info.exptime.toFixed(0)}</td>
        <td>${(l.info.coverage * 100).toFixed(0)}%</td><td>${flagChips(l.info.centerFlags) || "—"}</td>
        <td style="color:${qa === "Pass" ? "#7be0a8" : "#ff6b8b"}">${qa}</td></tr>`;
    })
    .join("");
  $("tbody").innerHTML = html;
}

/* ---------------------------------------------------------------- events */

function updatePlayBtn() {
  const b = $("btn-play");
  b.dataset.playing = String(S.playing);
  b.setAttribute("aria-label", S.playing ? "Pause" : "Play");
}

function loop(t: number) {
  if (S.playing && S.items.length > 1) {
    const step = 1000 / num("in-fps");
    if (t - S.lastTick >= step) {
      S.lastTick = t;
      S.cur = (S.cur + 1) % S.items.length;
      draw();
    }
  }
  requestAnimationFrame(loop);
}

function step(d: number) {
  if (!S.items.length) return;
  S.cur = (S.cur + d + S.items.length) % S.items.length;
  draw();
}

function canvasToGrid(e: PointerEvent | MouseEvent) {
  const r = ov.getBoundingClientRect();
  return { i: ((e.clientX - r.left) / r.width) * S.n - 0.5, j: ((e.clientY - r.top) / r.height) * S.n - 0.5 };
}

function bind() {
  const redraw = () => {
    syncUrl();
    draw();
  };
  const reb = () => {
    syncUrl();
    rebuild(true);
  };
  const out = (id: string, fmt: (v: string) => string) =>
    $(id).addEventListener("input", () => ($(`out-${id.slice(3)}`).textContent = fmt(val(id))));

  out("in-fov", (v) => `${v}′`);
  out("in-gap", (v) => `${v} d`);
  out("in-smooth", (v) => `${v} px`);
  out("in-hi", (v) => `${v}%`);
  out("in-lo", (v) => `${v}%`);
  out("in-fps", (v) => `${v} fps`);
  out("in-ap", (v) => `${v}″`);

  $("form-target").addEventListener("submit", (e) => {
    e.preventDefault();
    void load();
  });
  document.querySelectorAll<HTMLElement>("[data-target]").forEach((c) =>
    c.addEventListener("click", () => applyTarget(findTarget(c.dataset.target!)!)),
  );
  const unpreset = () => {
    if (!S.presetId) return;
    S.presetId = "";
    document.querySelectorAll("[data-target]").forEach((c) => c.classList.remove("on"));
    setVal("in-pmra", 0);
    setVal("in-pmdec", 0);
    setVal("in-epoch", 2000);
    setChk("in-track", false);
  };
  ["in-ra", "in-dec"].forEach((id) => $(id).addEventListener("input", unpreset));
  $("in-name").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      $("btn-resolve").click();
    }
  });
  $("btn-resolve").addEventListener("click", async () => {
    const q = val("in-name").trim();
    if (!q) return;
    const btn = $("btn-resolve") as HTMLButtonElement;
    btn.disabled = true;
    status(`Looking up “${q}”…`);
    try {
      const r = await fetch(`/api/resolve?q=${encodeURIComponent(q)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      const t = findTarget(j.id ?? "");
      if (t) return applyTarget(t, false), status(`${t.name}: ${t.note}`);
      S.presetId = "";
      setVal("in-ra", Number(j.ra).toFixed(6));
      setVal("in-dec", Number(j.dec).toFixed(6));
      setVal("in-pmra", j.pmra ?? 0);
      setVal("in-pmdec", j.pmdec ?? 0);
      setVal("in-epoch", j.epoch ?? 2000);
      status(`${q} → ${fmtRa(j.ra)} ${fmtDec(j.dec)} (${j.source}). Press “Load SPHEREx images”.`);
    } catch (e: any) {
      status(e.message ?? "Name lookup failed", true);
    } finally {
      btn.disabled = false;
    }
  });

  // processing / display controls
  ["in-mode", "in-diff", "in-comb", "in-bg", "in-gap"].forEach((id) => $(id).addEventListener("change", reb));
  $("in-mask").addEventListener("change", () => (resetMaskCaches(), reb()));
  $("in-mode").addEventListener("change", () => (($("row-gap") as HTMLElement).hidden = val("in-mode") !== "epochs"));
  $("in-gap").addEventListener("input", reb);
  ["in-smooth", "in-hi", "in-lo"].forEach((id) =>
    $(id).addEventListener("input", () => {
      S.smoothCache.clear();
      S.lockedRange = null;
      redraw();
    }),
  );
  ["in-stretch", "in-cmap", "in-lock", "in-pixel", "in-masked", "ov-pred", "ov-ap"].forEach((id) => {
    $(id).addEventListener("change", () => {
      S.lockedRange = null;
      redraw();
    });
  });
  ["ov-gaia", "ov-wise"].forEach((id) =>
    $(id).addEventListener("change", () => {
      void refreshCatalogs();
      redraw();
    }),
  );
  document.querySelectorAll<HTMLInputElement>("[data-det]").forEach((i) => i.addEventListener("change", reb));
  $("in-max").addEventListener("change", syncUrl);
  $("in-track").addEventListener("change", () => {
    syncUrl();
    if (Number.isFinite(S.target.ra)) void load();
  });
  ["in-pmra", "in-pmdec", "in-epoch"].forEach((id) => $(id).addEventListener("change", syncUrl));
  $("in-fov").addEventListener("change", () => {
    if (S.loaded.size || S.selected.length) void load();
  });

  // transport
  $("btn-play").addEventListener("click", () => {
    S.playing = !S.playing;
    updatePlayBtn();
  });
  $("btn-prev").addEventListener("click", () => ((S.playing = false), updatePlayBtn(), step(-1)));
  $("btn-next").addEventListener("click", () => ((S.playing = false), updatePlayBtn(), step(1)));
  $("in-frame").addEventListener("input", () => {
    S.cur = num("in-frame");
    S.playing = false;
    updatePlayBtn();
    draw();
  });
  document.addEventListener("keydown", (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" && (e.target as HTMLInputElement).type !== "range" && (e.target as HTMLInputElement).type !== "checkbox") return;
    if (tag === "SELECT" || tag === "TEXTAREA" || e.ctrlKey || e.metaKey) return;
    if (e.key === " " && tag !== "BUTTON") {
      e.preventDefault();
      $("btn-play").click();
    } else if (e.key === "ArrowRight" && tag !== "INPUT") step(1);
    else if (e.key === "ArrowLeft" && tag !== "INPUT") step(-1);
    else if (e.key === "d" || e.key === "D") {
      const s = $("in-diff") as HTMLSelectElement;
      s.selectedIndex = (s.selectedIndex + 1) % s.options.length;
      s.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  // image interaction
  ov.addEventListener("pointermove", (e) => {
    const it = S.items[S.cur];
    if (!it) return;
    const { i, j } = canvasToGrid(e);
    const ii = Math.round(i);
    const jj = Math.round(j);
    if (ii < 0 || jj < 0 || ii >= S.n || jj >= S.n) return void ($("hud-readout").textContent = "");
    const c = itemEpochCentre(it);
    const half = (S.n - 1) / 2;
    const s = gridScale / 3600;
    const [ra, dec] = tanToSky(c.ra, c.dec, (half - i) * s, (half - j) * s);
    const v = displayImage(it, S.cur)[jj * S.n + ii];
    const fl = it.frames.reduce((m, l) => m | l.flags[jj * S.n + ii], 0);
    // nearest catalogue source
    let near = "";
    let bd = 8 * 8;
    for (const cat of ["gaia", "wise"] as const) {
      const d = S.cats[cat];
      if (!d || !chk(cat === "gaia" ? "ov-gaia" : "ov-wise")) continue;
      for (const so of d.sources) {
        const p = propagate({ ra: so.ra, dec: so.dec, epoch: d.epoch, pmra: so.pmra ?? 0, pmdec: so.pmdec ?? 0 }, it.year);
        const [pi, pj] = toPix(c, p.ra, p.dec);
        const dd = (pi - i) ** 2 + (pj - j) ** 2;
        if (dd < bd) {
          bd = dd;
          near = `\n${cat === "gaia" ? "Gaia" : "WISE"} ${so.id}${so.mag !== null ? ` · mag ${so.mag.toFixed(1)}` : ""}`;
        }
      }
    }
    const el = $("hud-readout");
    el.style.whiteSpace = "pre";
    el.textContent = `${fmtRa(ra)} ${fmtDec(dec)}\n${Number.isFinite(v) ? v.toPrecision(3) + " MJy/sr" : "masked"}${fl ? " · " + FLAG_CATEGORIES.filter((_, b) => (fl >> b) & 1).map((x) => x.key).join("+") : ""}${near}`;
  });
  ov.addEventListener("pointerleave", () => ($("hud-readout").textContent = ""));
  ov.addEventListener("click", (e) => {
    if (!S.items.length) return;
    const { i, j } = canvasToGrid(e);
    S.ap = { x: i, y: j };
    measure();
    draw();
  });
  $("btn-ap-center").addEventListener("click", () => {
    S.ap = { x: (S.n - 1) / 2, y: (S.n - 1) / 2 };
    measure();
    draw();
  });
  $("in-ap").addEventListener("input", throttle(() => (measure(), draw()), 120));
  $("in-ap").addEventListener("change", syncUrl);
  $("in-curve-det").addEventListener("change", renderPlots);

  // table
  $("tbody").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const row = t.closest("tr") as HTMLElement | null;
    if (!row) return;
    if (t instanceof HTMLInputElement && t.dataset.ex) {
      if (t.checked) S.excluded.delete(t.dataset.ex);
      else S.excluded.add(t.dataset.ex);
      rebuild(true);
      return;
    }
    const l = S.loaded.get(row.dataset.url!);
    const i = S.items.findIndex((it) => l && it.frames.includes(l));
    if (i >= 0) {
      S.cur = i;
      S.playing = false;
      updatePlayBtn();
      draw();
    }
  });

  // tabs
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => {
        x.classList.toggle("on", x === t);
        x.setAttribute("aria-selected", String(x === t));
      });
      document.querySelectorAll<HTMLElement>(".pane").forEach((p) => p.classList.toggle("on", p.dataset.pane === t.dataset.tab));
      specPlot.draw();
      curvePlot.draw();
    }),
  );

  // misc buttons
  $("btn-share").addEventListener("click", async () => {
    syncUrl();
    try {
      await navigator.clipboard.writeText(location.href);
      status("Link copied. It reopens this exact view.");
    } catch {
      status(location.href);
    }
  });
  $("btn-help").addEventListener("click", () => ($("dlg-help") as HTMLDialogElement).showModal());
  $("btn-png").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = cv.toDataURL("image/png");
    a.download = `spherex_${S.target.name || "field"}_${S.cur + 1}.png`.replace(/\s+/g, "_");
    a.click();
  });
  $("btn-csv").addEventListener("click", () => {
    const rows = ["index,obs_id,detector,mjd,utc,wavelength_um,bandwidth_um,flux_Jy,flux_err_Jy,bkg_MJy_sr,valid_fraction"];
    activeFrames().forEach((l, i) => {
      const p = l.phot;
      rows.push(
        [i + 1, l.info.obsId, l.info.det, l.info.mjd.toFixed(5), mjdToUtc(l.info.mjd), waveAtAp(l)?.toFixed(4) ?? "", l.info.bw?.toFixed(4) ?? "", p?.flux ?? "", p?.err ?? "", p?.bkg ?? "", p?.valid.toFixed(2) ?? ""].join(","),
      );
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
    a.download = `spherex_photometry_${(S.target.name || "field").replace(/\s+/g, "_")}.csv`;
    a.click();
  });
  $("btn-aladin").addEventListener("click", () => {
    if (!Number.isFinite(S.center.ra)) return status("Load a target first.", true);
    const href = ($("link-aladin") as HTMLAnchorElement).href;
    $("context-box").innerHTML = `<iframe src="${href}" title="Aladin Lite sky context" loading="lazy"></iframe>`;
  });

  new ResizeObserver(() => draw()).observe(cv);
}

/* ------------------------------------------------------------------- init */

bind();
(window as any).__spx = { S, activeFrames, propagate, skyToTan, tanToSky, gridScale }; // handy for debugging in the console
const auto = readUrl();
$("row-gap").hidden = val("in-mode") !== "epochs";
["in-fov", "in-gap", "in-smooth", "in-hi", "in-lo", "in-fps", "in-ap"].forEach((id) => $(id).dispatchEvent(new Event("input")));
requestAnimationFrame(loop);
if (auto) void load();
