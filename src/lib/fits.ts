/**
 * Minimal FITS multi-extension reader (big-endian images + the one binary
 * table we need). Works on Node Buffers / Uint8Arrays and in the browser.
 */

export type CardValue = string | number | boolean | null;

export interface Hdu {
  header: Record<string, CardValue>;
  /** byte offset of the data unit */
  dataStart: number;
  /** data size in bytes (without padding) */
  dataBytes: number;
}

const BLOCK = 2880;

function parseValue(raw: string): CardValue {
  let v = raw.trim();
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1);
    // strings may contain doubled quotes; good enough for SPHEREx headers
    return v.slice(1, end < 0 ? undefined : end).trimEnd();
  }
  const slash = v.indexOf("/");
  if (slash >= 0) v = v.slice(0, slash).trim();
  if (v === "T") return true;
  if (v === "F") return false;
  if (v === "") return null;
  const n = Number(v.replace(/[dD]/, "e"));
  return Number.isNaN(n) ? v : n;
}

export function parseHdus(buf: Uint8Array): Hdu[] {
  const hdus: Hdu[] = [];
  const dec = new TextDecoder("ascii");
  let pos = 0;
  while (pos + BLOCK <= buf.length) {
    const header: Record<string, CardValue> = {};
    let ended = false;
    while (!ended && pos + BLOCK <= buf.length) {
      const block = dec.decode(buf.subarray(pos, pos + BLOCK));
      pos += BLOCK;
      for (let i = 0; i < BLOCK; i += 80) {
        const card = block.slice(i, i + 80);
        const key = card.slice(0, 8).trim();
        if (key === "END") {
          ended = true;
          break;
        }
        if (key === "HIERARCH") {
          const eq = card.indexOf("=");
          if (eq > 0) {
            const name = card.slice(8, eq).trim().replace(/\s+/g, " ");
            header[name] = parseValue(card.slice(eq + 1));
          }
          continue;
        }
        if (card[8] === "=") header[key] = parseValue(card.slice(10));
      }
    }
    if (!ended) break;
    const naxis = Number(header["NAXIS"] ?? 0);
    let bytes = 0;
    if (naxis > 0) {
      bytes = Math.abs(Number(header["BITPIX"])) / 8;
      for (let a = 1; a <= naxis; a++) bytes *= Number(header[`NAXIS${a}`]);
      bytes += Number(header["PCOUNT"] ?? 0);
    }
    hdus.push({ header, dataStart: pos, dataBytes: bytes });
    pos += Math.ceil(bytes / BLOCK) * BLOCK;
  }
  return hdus;
}

export function findHdu(hdus: Hdu[], extname: string): Hdu | undefined {
  return hdus.find((h) => String(h.header["EXTNAME"] ?? "").trim() === extname);
}

export function readImage(buf: Uint8Array, hdu: Hdu): {
  data: Float32Array | Int32Array;
  nx: number;
  ny: number;
} {
  const nx = Number(hdu.header["NAXIS1"]);
  const ny = Number(hdu.header["NAXIS2"]);
  const bitpix = Number(hdu.header["BITPIX"]);
  const dv = new DataView(buf.buffer, buf.byteOffset + hdu.dataStart, hdu.dataBytes);
  const n = nx * ny;
  if (bitpix === -32) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, false);
    return { data: out, nx, ny };
  }
  if (bitpix === 32) {
    const out = new Int32Array(n);
    for (let i = 0; i < n; i++) out[i] = dv.getInt32(i * 4, false);
    return { data: out, nx, ny };
  }
  throw new Error(`Unsupported BITPIX ${bitpix}`);
}

/** Reads the SPHEREx WCS-WAVE lookup table (X[9], Y[14], VALUES[2,9,14]). */
export function readWaveTable(buf: Uint8Array, hdu: Hdu) {
  const dv = new DataView(buf.buffer, buf.byteOffset + hdu.dataStart, hdu.dataBytes);
  const nx = parseInt(String(hdu.header["TFORM1"]), 10); // 9J
  const ny = parseInt(String(hdu.header["TFORM2"]), 10); // 14J
  const xs: number[] = [];
  const ys: number[] = [];
  let off = 0;
  for (let i = 0; i < nx; i++, off += 4) xs.push(dv.getInt32(off, false));
  for (let i = 0; i < ny; i++, off += 4) ys.push(dv.getInt32(off, false));
  const vals = new Float32Array(2 * nx * ny);
  for (let i = 0; i < vals.length; i++, off += 4) vals[i] = dv.getFloat32(off, false);
  return { xs, ys, vals, nx, ny };
}
