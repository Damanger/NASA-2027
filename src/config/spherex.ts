/**
 * Central configuration. To add a NEW SPHEREx data release (QR4, DR2, ...)
 * just append its IRSA SIA collection name to COLLECTIONS (newest first –
 * when the same exposure appears in two collections the first one wins).
 * Nothing else in the app has to change.
 */

export const IRSA_BASE = "https://irsa.ipac.caltech.edu";

export const COLLECTIONS: { id: string; label: string }[] = [
  { id: "spherex_qr3", label: "Quick Release 3" },
  { id: "spherex_dr1", label: "Data Release 1" },
  // { id: "spherex_dr2", label: "Data Release 2" },   <- example: add new releases here
];

/** Only cutouts under this prefix may be proxied (prevents SSRF). */
export const ALLOWED_IMAGE_PREFIX = `${IRSA_BASE}/ibe/data/spherex/`;

/** SPHEREx detector arrays and their nominal wavelength coverage (µm). */
export const DETECTORS: Record<number, { name: string; min: number; max: number; color: string }> = {
  1: { name: "D1", min: 0.75, max: 1.09, color: "#6aa7ff" },
  2: { name: "D2", min: 1.1, max: 1.62, color: "#4fd1c5" },
  3: { name: "D3", min: 1.63, max: 2.41, color: "#9ae66e" },
  4: { name: "D4", min: 2.42, max: 3.82, color: "#ffd166" },
  5: { name: "D5", min: 3.83, max: 4.41, color: "#ff9f5a" },
  6: { name: "D6", min: 4.42, max: 5.0, color: "#ff6b8b" },
};

/** Native SPHEREx pixel scale in arcsec. */
export const NATIVE_SCALE = 6.15;

/** Output grid is oversampled by this factor for smoother blinking. */
export const OVERSAMPLE = 2;

/** Max simultaneous cutout downloads against IRSA. */
export const MAX_CONCURRENT_DOWNLOADS = 10;

/**
 * FLAGS bit meanings. Bits were identified by matching per-bit pixel counts in a
 * full detector image against the `L2 N_*` counters in the FITS header.
 */
export const FLAG_BITS: Record<number, string> = {
  0: "TRANSIENT",
  1: "OVERFLOW",
  2: "SUR_ERROR",
  6: "NONFUNC",
  7: "DICHROIC",
  10: "HOT",
  11: "COLD",
  12: "FULLSAMPLE",
  17: "PERSIST",
  19: "OUTLIER",
  21: "SOURCE",
  26: "BLOOM",
  27: "SNOWBALL",
  28: "HALO",
};

/**
 * Bits that always make a pixel unusable (masked to NaN on the server).
 * TRANSIENT / OVERFLOW / SUR_ERROR / OUTLIER / BLOOM / HALO are deliberately NOT here: in a full
 * detector image ~60% of the brightest pixels carry one of them, because they fire on
 * saturated star cores. Masking them would erase the very sources we want to see, so
 * the viewer only masks them in "strict" mode. SOURCE and PERSIST are informational.
 */
export const BAD_BITS = [6, 7, 9, 10, 11, 12, 13, 14, 27, 29];

/** Compact 16-bit category field sent to the browser: category -> source bits. */
export const FLAG_CATEGORIES: { key: string; label: string; bits: number[]; bad: boolean; hint: string; soft?: boolean }[] = [
  { key: "TRANSIENT", label: "Transient", bits: [0], bad: true, soft: true, hint: "Cosmic ray / transient in the up-the-ramp fit" },
  { key: "OVERFLOW", label: "Overflow", bits: [1], bad: true, soft: true, hint: "Pixel saturated (ADC overflow)" },
  { key: "SUR_ERROR", label: "SUR error", bits: [2], bad: true, soft: true, hint: "Sample-up-the-ramp fit failed" },
  { key: "NONFUNC", label: "Non-functional", bits: [6], bad: true, hint: "Permanently dead pixel" },
  { key: "DICHROIC", label: "Dichroic", bits: [7], bad: true, hint: "Low throughput region of the dichroic" },
  { key: "HOT", label: "Hot", bits: [10], bad: true, hint: "Hot pixel" },
  { key: "COLD", label: "Cold", bits: [11], bad: true, hint: "Low-response pixel" },
  { key: "FULLSAMPLE", label: "Full sample", bits: [12], bad: true, hint: "Full-sample mode artefact" },
  { key: "PERSIST", label: "Persistence", bits: [17], bad: false, hint: "Residual charge from a previous bright source" },
  { key: "OUTLIER", label: "Outlier", bits: [19], bad: true, soft: true, hint: "Statistical outlier pixel" },
  { key: "SOURCE", label: "Source", bits: [21], bad: false, hint: "Pixel belongs to a detected source (informational)" },
  { key: "BLOOM", label: "Bloom", bits: [26], bad: true, soft: true, hint: "Charge bleed from a bright star" },
  { key: "SNOWBALL", label: "Snowball", bits: [27], bad: true, hint: "Snowball cosmic-ray artefact" },
  { key: "HALO", label: "Halo", bits: [28], bad: true, soft: true, hint: "Cosmic-ray halo" },
  { key: "OTHER", label: "Other bad", bits: [9, 13, 14, 29], bad: true, hint: "Missing data / non-linear / other" },
  { key: "OFFIMAGE", label: "Off detector", bits: [], bad: true, hint: "Outside the detector footprint" },
];

export const CACHE_DIR = ".cache/spherex";
