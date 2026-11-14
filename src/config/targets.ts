/**
 * Featured targets. Coordinates are ICRS degrees at `epoch`; proper motions in
 * mas/yr. Positions come from Gaia DR3 (epoch 2016.0) unless noted.
 */
export interface Target {
  id: string;
  name: string;
  ra: number;
  dec: number;
  /** Julian epoch of ra/dec */
  epoch: number;
  pmra: number;
  pmdec: number;
  note: string;
  /** one plain-language sentence: what the visitor should look for */
  hint: string;
  /** suggested field of view (arcmin) */
  fov: number;
  /** suggested photometry aperture radius (arcsec); bright stars saturate and need a larger one */
  ap?: number;
  kind: string;
}

export const TARGETS: Target[] = [
  {
    id: "wise0855",
    name: "WISE 0855−0714",
    ra: 133.795129,
    dec: -7.245147,
    // Position quoted in the challenge is the discovery-era (WISE, epoch ~2010.5) position;
    // checked against SPHEREx D5/D6 detections, which sit within ~3″ of the propagated position.
    epoch: 2010.3,
    pmra: -8118,
    pmdec: 680,
    fov: 4,
    kind: "Fast-moving brown dwarf",
    hint: "Look for a faint dot creeping west. It only shows up in the reddest colour bands (D5 and D6).",
    note: "Coldest known brown dwarf (~285 K), 2.3 pc away, moving 8.1″ per year. Catalogue position 08h55m10.831s −07°14′42.53″ (epoch ≈2010), propagated to the SPHEREx epoch.",
  },
  {
    id: "barnard",
    name: "Barnard's Star",
    ra: 269.44850253,
    dec: 4.73942005,
    epoch: 2016.0,
    pmra: -801.55,
    pmdec: 10362.39,
    ap: 24,
    fov: 4,
    kind: "Nearby red dwarf",
    hint: "Look for a bright star sliding north, about 10″ every year.",
    note: "Fastest-moving star in the sky: 10.4″ per year, 1.83 pc away.",
  },
  {
    id: "epsindi-b",
    name: "Epsilon Indi Ba/Bb",
    ra: 331.0764526,
    dec: -56.79381206,
    epoch: 2016.0,
    pmra: 3981.98,
    pmdec: -2466.83,
    fov: 4,
    kind: "Brown-dwarf pair",
    hint: "Two brown dwarfs, too close to separate, drifting across the field.",
    note: "A pair of brown dwarfs orbiting the K-dwarf Epsilon Indi A, 3.6 pc away. They are too close to resolve with SPHEREx (≈1.5″ apart).",
  },
  {
    id: "epsindi-a",
    name: "Epsilon Indi A",
    ra: 330.8724079,
    dec: -56.79725467,
    epoch: 2016.0,
    pmra: 3966.66,
    pmdec: -2536.19,
    ap: 30,
    fov: 12,
    kind: "Host star",
    hint: "Widen the view to see the host star together with its brown dwarfs.",
    note: "Host star of the Epsilon Indi system and its giant planet. Use a ≥10′ field to see both A and Ba/Bb.",
  },
  {
    id: "rwaur",
    name: "RW Aurigae",
    ra: 76.9560812,
    dec: 30.40120459,
    epoch: 2016.0,
    pmra: 2.64,
    pmdec: -27.4,
    fov: 4,
    kind: "Variable T Tauri star",
    hint: "A young star that dims and brightens. Open “Brightness over time”.",
    note: "Young, irregularly dimming star surrounded by a disk. Watch its brightness change in the light curve.",
  },
  {
    id: "rdra",
    name: "R Draconis",
    ra: 248.16737837,
    dec: 66.75500675,
    epoch: 2016.0,
    pmra: -20.64,
    pmdec: 6.15,
    ap: 30,
    fov: 4,
    kind: "Mira variable",
    hint: "A pulsating giant whose brightness swings every ~245 days.",
    note: "Pulsating red giant with a ~245-day cycle. Its brightness swings by several magnitudes.",
  },
];

export function findTarget(id: string) {
  return TARGETS.find((t) => t.id === id);
}
