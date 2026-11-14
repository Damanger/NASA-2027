/**
 * Interface glue for the guided flow: which screen is showing, the 3-step guide,
 * plain-language controls (segmented picker, switches, suggestions) and the
 * "change spot" sheet. All analysis logic stays in app.ts; this file only reads and
 * writes the same form controls, so URLs, keyboard shortcuts and embeds keep working.
 */
import { findTarget } from "../config/targets.ts";

type Phase = "idle" | "loading" | "ready" | "nodata" | "error";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

let phase: Phase = "idle";
let dugDeeper = false; // the visitor has touched a step-3 tool
let wasWorkspace = false;

/* ----------------------------------------------------------- native-select helpers */

function setSelect(id: string, value: string) {
  const el = $(id) as HTMLSelectElement;
  if (el.value === value) return;
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const MODE_HINT: Record<string, string> = {
  frames: "Plays every snapshot in the order it was taken. Different colour bands look different, so brightness may flicker.",
  detector: "Adds up all snapshots in each colour band: six images from blue to red. Good for objects that glow only in the red.",
  epochs: "Adds up snapshots taken close together in time. Compare visits months apart to see things move.",
};

/** Make every control reflect the real form values (after URL load, after a click). */
function syncUi() {
  // segmented picker
  document.querySelectorAll<HTMLElement>("[data-seg]").forEach((seg) => {
    const sel = $(seg.dataset.seg!) as HTMLSelectElement;
    seg.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      const on = b.dataset.value === sel.value;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
  });
  $("mode-hint").textContent = MODE_HINT[($("in-mode") as HTMLSelectElement).value] ?? "";

  // "Highlight what changed" = difference vs the typical sky
  const diff = ($("in-diff") as HTMLSelectElement).value;
  ($("tg-diff") as HTMLInputElement).checked = diff !== "none";
  $("act-diff").setAttribute("aria-pressed", String(diff !== "none"));
  $("act-bands").setAttribute("aria-pressed", String(($("in-mode") as HTMLSelectElement).value === "detector"));

  // following an object needs a known motion
  const hasPm = Number(($("in-pmra") as HTMLInputElement).value) !== 0 || Number(($("in-pmdec") as HTMLInputElement).value) !== 0;
  const track = $("in-track") as HTMLInputElement;
  track.disabled = !hasPm;
  if (!hasPm) track.checked = false;
  $("track-help").textContent = hasPm
    ? "Keeps it centred while the stars trail behind."
    : "Needs a known motion. Try one of the example objects.";
}

/* ------------------------------------------------------------------- the 3 steps */

function setSteps() {
  const s: Record<number, string> = { 1: "active", 2: "todo", 3: "todo" };
  if (phase === "loading") Object.assign(s, { 1: "done", 2: "active", 3: "todo" });
  if (phase === "ready")
    Object.assign(s, dugDeeper ? { 1: "done", 2: "done", 3: "active" } : { 1: "done", 2: "active", 3: "next" });
  document.querySelectorAll<HTMLElement>(".step").forEach((li) => {
    const st = s[Number(li.dataset.step)];
    li.dataset.state = st;
    const btn = li.querySelector("button")!;
    if (st === "active") btn.setAttribute("aria-current", "step");
    else btn.removeAttribute("aria-current");
  });
}

/* ------------------------------------------------------------------- phases */

function targetBar() {
  const name = ($("in-name") as HTMLInputElement).value.trim();
  const ra = Number(($("in-ra") as HTMLInputElement).value);
  const dec = Number(($("in-dec") as HTMLInputElement).value);
  $("tb-name").textContent = name || "Your coordinates";
  const pos = Number.isFinite(ra) && Number.isFinite(dec) && ra !== 0 ? `RA ${ra.toFixed(4)}°  Dec ${dec.toFixed(4)}°` : "";
  $("tb-sub").textContent = `${pos}${pos ? "  ·  " : ""}${($("in-fov") as HTMLInputElement).value}′ view`;
}

function coach() {
  const el = $("coach");
  if (phase === "loading") {
    el.textContent =
      "Collecting snapshots from NASA's archive. The first visit to a spot takes a minute or two. Anything you've seen before loads instantly.";
    return;
  }
  const id = (window as any).__spx?.S.presetId as string | undefined;
  const t = id ? findTarget(id) : undefined;
  el.innerHTML = "";
  const b = document.createElement("b");
  b.textContent = t ? "What to look for: " : "Press play. ";
  el.append(b, t ? t.hint : "Distant stars stay put. Anything that shifts between snapshots is moving. Click the image to measure a spot.");
}

function applyPhase(p: Phase) {
  phase = p;
  document.body.dataset.phase = p;
  const showWorkspace = p === "loading" || p === "ready";
  $("welcome").hidden = showWorkspace;
  $("workspace").hidden = !showWorkspace;
  if (showWorkspace) {
    const dlg = $("dlg-picker") as HTMLDialogElement;
    if (dlg.open) dlg.close();
    targetBar();
    coach();
    if (!wasWorkspace && !reduceMotion()) window.scrollTo({ top: 0, behavior: "smooth" });
    if (!wasWorkspace) window.scrollTo({ top: 0 });
  } else {
    // errors/no-data send people back to step 1 with the message visible
    if (wasWorkspace) window.scrollTo({ top: 0 });
  }
  wasWorkspace = showWorkspace;
  if (p === "loading") dugDeeper = false;
  syncUi();
  setSteps();
}

document.addEventListener("spx:phase", (e) => applyPhase((e as CustomEvent).detail.phase as Phase));

/* ------------------------------------------------------------- segmented controls */

document.querySelectorAll<HTMLElement>("[data-seg]").forEach((seg) => {
  const buttons = [...seg.querySelectorAll<HTMLButtonElement>("button")];
  const apply = (b: HTMLButtonElement) => {
    setSelect(seg.dataset.seg!, b.dataset.value!);
    syncUi();
  };
  buttons.forEach((b, i) => {
    b.addEventListener("click", () => apply(b));
    b.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const n = buttons[(i + d + buttons.length) % buttons.length];
      n.focus();
      apply(n);
    });
  });
});

/* any control that can change the view re-syncs the friendly controls */
["in-mode", "in-diff", "in-pmra", "in-pmdec"].forEach((id) =>
  $(id).addEventListener("change", () => {
    syncUi();
  }),
);
$("tg-diff").addEventListener("change", () => {
  setSelect("in-diff", ($("tg-diff") as HTMLInputElement).checked ? "median" : "none");
  syncUi();
});

/* "step 3" counts as started as soon as the visitor touches a tool or the analysis area */
const markDug = () => {
  if (phase === "ready" && !dugDeeper) {
    dugDeeper = true;
    setSteps();
  }
};
$("tools").addEventListener("change", markDug);
$("analysis").addEventListener("click", markDug);
$("ov").addEventListener("click", markDug);

/* ----------------------------------------------------------------- suggestions */

$("act-diff").addEventListener("click", () => {
  const on = ($("in-diff") as HTMLSelectElement).value === "none";
  setSelect("in-diff", on ? "median" : "none");
  syncUi();
  markDug();
});
$("act-bands").addEventListener("click", () => {
  const cur = ($("in-mode") as HTMLSelectElement).value;
  setSelect("in-mode", cur === "detector" ? "frames" : "detector");
  syncUi();
  markDug();
});
$("act-measure").addEventListener("click", () => {
  document.querySelector<HTMLElement>('[data-tab="spectrum"]')!.click();
  $("analysis").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
  markDug();
});

/* ------------------------------------------------------------- the step buttons */

const say = (m: string) => {
  const s = $("status");
  s.textContent = m;
  s.classList.remove("err");
};
$("step-1").addEventListener("click", () => {
  if (phase === "ready" || phase === "loading") openPicker();
  else {
    $("tcards").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" });
    document.querySelector<HTMLElement>(".tcard")?.focus({ preventScroll: true });
  }
});
$("step-2").addEventListener("click", () => {
  if (phase === "idle" || phase === "nodata" || phase === "error") return say("Pick a spot first, then press play.");
  $("viewer").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
  $("btn-play").focus({ preventScroll: true });
});
$("step-3").addEventListener("click", () => {
  if (phase !== "ready") return say(phase === "loading" ? "Almost there. The snapshots are still arriving." : "Pick a spot first, then you can dig deeper.");
  $("tools").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
  markDug();
});

/* ------------------------------------------------------- change-spot sheet */

const picker = $("picker-home").querySelector<HTMLElement>("#form-target")!;
const dlg = $("dlg-picker") as HTMLDialogElement;
function openPicker() {
  $("picker-dialog-body").appendChild(picker);
  dlg.showModal();
}
function restorePicker() {
  const home = $("picker-home");
  if (picker.parentElement !== home) home.appendChild(picker);
}
$("btn-change").addEventListener("click", openPicker);
$("btn-picker-close").addEventListener("click", () => dlg.close());
dlg.addEventListener("close", restorePicker);
dlg.addEventListener("click", (e) => {
  if (e.target === dlg) dlg.close(); // click on the backdrop
});

/* ------------------------------------------------------------------- boot */

syncUi();
applyPhase((document.body.dataset.phase as Phase) || "idle");
