/** Tiny dependency-free scatter/line plot with error bars, hover and click-to-pick. */

export interface Pt {
  x: number;
  y: number;
  e?: number;
  /** index of the frame this point belongs to */
  id: number;
}
export interface Series {
  label: string;
  color: string;
  pts: Pt[];
  line?: boolean;
}

export interface PlotOpts {
  xLabel: string;
  yLabel: string;
  xFmt: (v: number) => string;
  yFmt?: (v: number) => string;
  onPick?: (id: number) => void;
  tip?: (p: Pt, s: Series) => string;
  logX?: boolean;
}

function niceTicks(lo: number, hi: number, target = 6): number[] {
  const span = hi - lo || 1;
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

export class Plot {
  private ctx: CanvasRenderingContext2D;
  private series: Series[] = [];
  private cursorId: number | null = null;
  private hover: { p: Pt; s: Series } | null = null;
  private box = { l: 58, r: 14, t: 12, b: 38 };
  private dpr = 1;
  private w = 0;
  private h = 0;
  private xr: [number, number] = [0, 1];
  private yr: [number, number] = [0, 1];
  private emptyMsg = "No data yet";

  constructor(
    private canvas: HTMLCanvasElement,
    private o: PlotOpts,
  ) {
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener("pointermove", (e) => this.onMove(e));
    canvas.addEventListener("pointerleave", () => {
      this.hover = null;
      this.draw();
    });
    canvas.addEventListener("click", () => {
      if (this.hover && this.o.onPick) this.o.onPick(this.hover.p.id);
    });
    this.resize();
  }

  setEmpty(msg: string) {
    this.emptyMsg = msg;
    this.draw();
  }

  setData(series: Series[]) {
    this.series = series.filter((s) => s.pts.length);
    const xs = this.series.flatMap((s) => s.pts.map((p) => p.x));
    const ys = this.series.flatMap((s) => s.pts.flatMap((p) => [p.y - (p.e ?? 0), p.y + (p.e ?? 0)]));
    if (xs.length) {
      let [x0, x1] = [Math.min(...xs), Math.max(...xs)];
      if (x0 === x1) {
        x0 -= 1;
        x1 += 1;
      }
      const px = (x1 - x0) * 0.04;
      this.xr = [x0 - px, x1 + px];
      let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
      if (y0 === y1) {
        y0 -= 1;
        y1 += 1;
      }
      const py = (y1 - y0) * 0.08;
      this.yr = [y0 - py, y1 + py];
    }
    this.draw();
  }

  setCursor(id: number | null) {
    this.cursorId = id;
    this.draw();
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = Math.max(50, r.width);
    this.h = Math.max(50, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.draw();
  }

  private sx(x: number) {
    const { l, r } = this.box;
    return l + ((x - this.xr[0]) / (this.xr[1] - this.xr[0])) * (this.w - l - r);
  }
  private sy(y: number) {
    const { t, b } = this.box;
    return t + (1 - (y - this.yr[0]) / (this.yr[1] - this.yr[0])) * (this.h - t - b);
  }

  private onMove(e: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best: { p: Pt; s: Series } | null = null;
    let bd = 14 * 14;
    for (const s of this.series)
      for (const p of s.pts) {
        const d = (this.sx(p.x) - mx) ** 2 + (this.sy(p.y) - my) ** 2;
        if (d < bd) {
          bd = d;
          best = { p, s };
        }
      }
    this.hover = best;
    this.canvas.style.cursor = best ? "pointer" : "default";
    this.draw();
  }

  draw() {
    const c = this.ctx;
    const css = getComputedStyle(this.canvas);
    const fg = css.getPropertyValue("--plot-fg").trim() || "#c8d0e0";
    const grid = css.getPropertyValue("--plot-grid").trim() || "rgba(255,255,255,.08)";
    const accent = css.getPropertyValue("--plot-accent").trim() || "#ffb454";
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    c.font = "11px ui-sans-serif, system-ui, sans-serif";
    if (!this.series.length) {
      c.fillStyle = fg;
      c.globalAlpha = 0.6;
      c.textAlign = "center";
      c.fillText(this.emptyMsg, this.w / 2, this.h / 2);
      c.globalAlpha = 1;
      return;
    }
    const { l, r, t, b } = this.box;
    // grid + ticks
    c.strokeStyle = grid;
    c.fillStyle = fg;
    c.lineWidth = 1;
    c.textAlign = "center";
    for (const v of niceTicks(this.xr[0], this.xr[1], Math.max(3, Math.floor(this.w / 90)))) {
      const x = Math.round(this.sx(v)) + 0.5;
      c.beginPath();
      c.moveTo(x, t);
      c.lineTo(x, this.h - b);
      c.stroke();
      c.fillText(this.o.xFmt(v), x, this.h - b + 14);
    }
    c.textAlign = "right";
    for (const v of niceTicks(this.yr[0], this.yr[1], 5)) {
      const y = Math.round(this.sy(v)) + 0.5;
      c.beginPath();
      c.moveTo(l, y);
      c.lineTo(this.w - r, y);
      c.stroke();
      c.fillText((this.o.yFmt ?? ((q) => String(+q.toPrecision(3))))(v), l - 6, y + 3);
    }
    c.textAlign = "center";
    c.fillText(this.o.xLabel, l + (this.w - l - r) / 2, this.h - 6);
    c.save();
    c.translate(12, t + (this.h - t - b) / 2);
    c.rotate(-Math.PI / 2);
    c.fillText(this.o.yLabel, 0, 0);
    c.restore();

    // cursor line
    if (this.cursorId !== null) {
      for (const s of this.series) {
        const p = s.pts.find((q) => q.id === this.cursorId);
        if (p) {
          c.strokeStyle = accent;
          c.globalAlpha = 0.7;
          c.setLineDash([4, 3]);
          c.beginPath();
          c.moveTo(this.sx(p.x), t);
          c.lineTo(this.sx(p.x), this.h - b);
          c.stroke();
          c.setLineDash([]);
          c.globalAlpha = 1;
          break;
        }
      }
    }

    c.save();
    c.beginPath();
    c.rect(l, t - 4, this.w - l - r, this.h - t - b + 8);
    c.clip();
    for (const s of this.series) {
      c.strokeStyle = s.color;
      c.fillStyle = s.color;
      if (s.line) {
        c.globalAlpha = 0.5;
        c.beginPath();
        s.pts.forEach((p, i) => (i ? c.lineTo(this.sx(p.x), this.sy(p.y)) : c.moveTo(this.sx(p.x), this.sy(p.y))));
        c.stroke();
        c.globalAlpha = 1;
      }
      for (const p of s.pts) {
        const x = this.sx(p.x);
        const y = this.sy(p.y);
        if (p.e) {
          c.globalAlpha = 0.45;
          c.beginPath();
          c.moveTo(x, this.sy(p.y - p.e));
          c.lineTo(x, this.sy(p.y + p.e));
          c.stroke();
          c.globalAlpha = 1;
        }
        const cur = p.id === this.cursorId;
        c.beginPath();
        c.arc(x, y, cur ? 5 : 2.8, 0, Math.PI * 2);
        c.fill();
        if (cur) {
          c.strokeStyle = "#fff";
          c.lineWidth = 1.5;
          c.stroke();
          c.lineWidth = 1;
          c.strokeStyle = s.color;
        }
      }
    }
    c.restore();

    if (this.hover) {
      const { p, s } = this.hover;
      const text = this.o.tip ? this.o.tip(p, s) : `${this.o.xFmt(p.x)}  ${p.y.toPrecision(3)}`;
      const lines = text.split("\n");
      const wBox = Math.max(...lines.map((q) => c.measureText(q).width)) + 14;
      const hBox = lines.length * 14 + 8;
      let bx = this.sx(p.x) + 10;
      if (bx + wBox > this.w - 4) bx = this.sx(p.x) - wBox - 10;
      const by = Math.max(4, Math.min(this.h - hBox - 4, this.sy(p.y) - hBox / 2));
      c.fillStyle = "rgba(10,14,24,.92)";
      c.strokeStyle = s.color;
      c.beginPath();
      c.roundRect(bx, by, wBox, hBox, 5);
      c.fill();
      c.stroke();
      c.fillStyle = "#e9eefc";
      c.textAlign = "left";
      lines.forEach((q, i) => c.fillText(q, bx + 7, by + 15 + i * 14));
    }
  }
}
