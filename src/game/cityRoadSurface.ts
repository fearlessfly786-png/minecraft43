/**
 * CITY ROAD SURFACE — the physics twin of the 3D road deck built in
 * cityRoadmap.ts. The flat painted map was a decal; the city's roads are
 * now REAL raised 3D block roads (asphalt deck + kerbed rock walkways +
 * white block markings), so every height consumer — the player's ground
 * snap, the jeep's suspension, the camera clearance, mob walkers, the
 * spawn finders — must ride the new deck instead of the bare plateau.
 *
 * ONE TRUTH, TWO LAYERS:
 *  - cityRoadmap.ts builds the visible CUBE deck: one terrain-style cube
 *    per plateau block, textured/heighted by the class this raster
 *    reports (asphalt road / rock footpath / grass island).
 *  - this module rasterizes the SAME vectors once into a BLOCK-resolution
 *    grid (one cell per terrain block; walk / road / island bits) so
 *    per-frame queries are a single array read — O(1), zero allocations,
 *    and pixel-identical to the visible cube field.
 *
 * HEIGHT MODEL (all lifts above terrain.cityTopY(), the flattened
 * plateau top) — CUBE BLOCK heights, same stepped scale as the terrain
 * itself (1 cube = CITY_BLOCK = 100 world units):
 *      base quad (painted grass/water underlay)    +CITY_QUAD_LIFT
 *      asphalt road cube top                       +CITY_ROAD_RISE (1 block)
 *      kerbed footpath cube top                    +CITY_WALK_RISE (2 blocks —
 *                                                    ONE BLOCK above the road)
 *      roundabout grass island cube top            +CITY_ISLAND_RISE
 *      white marking blocks (visual only, no lift) +CITY_MARK_H thick
 * The raster is BLOCK-RESOLUTION (one cell per terrain block) so the
 * physics answers from exactly the same blocky field the visible cube
 * deck is built from — what you stand on is what you see.
 * Outside the plateau rect the lift is 0 — the natural world is
 * untouched. Pure math + one lazy Uint8Array; no three.js, no DOM.
 */

import { CITY_PATHS, CITY_ROUNDABOUTS, CITY_IMG_H } from './cityRoadmapData';
import {
  CITY_WX0,
  CITY_WX1,
  CITY_WZ0,
  CITY_WZ1,
  CITY_WW,
  CITY_WD,
  CITY_UPP,
  CITY_SCALE,
  cityRoadWU,
  citySidewalkExtra,
} from './cityLayout';

/* ------------------------------ tuning ---------------------------------- */

/** Painted base quad lift above the flattened plateau top (the deck's
 *  "ground floor" — matches the flat quad's position in cityRoadmap). */
export const CITY_QUAD_LIFT = 3;
/** Asphalt road cube top above the base datum (ONE full block). */
export const CITY_ROAD_RISE = 100;
/** Kerbed footpath cube top — TWO blocks above the ground, i.e. ONE
 *  BLOCK higher than the road cubes (real raised sidewalks). */
export const CITY_WALK_RISE = 200;
/** Roundabout grass island cube top (same level as the road ring). */
export const CITY_ISLAND_RISE = 100;
/** White marking block thickness (visual paint-thin cubes on the road). */
export const CITY_MARK_H = 16;

/** Raster cell = ONE terrain block — the physics field IS the cube grid. */
const CELL = 100;
const GW = Math.round(CITY_WW / CELL); // 768
const GH = Math.round(CITY_WD / CELL); // 512

const WALK_BIT = 1;
const ROAD_BIT = 2;
const ISLAND_BIT = 4;

/* ------------------------------ raster ---------------------------------- */

let grid: Uint8Array | null = null;

/** Rasterize the road network once: every path stamps a road disc (its
 *  traced half-width) and a walk disc (half-width + sidewalk extra)
 *  along the polyline; every roundabout stamps the walk apron (r+26),
 *  the asphalt disc (r+14) and the sunken grass island (r-15) — the
 *  same numbers the cube deck uses, so physics and geometry agree. */
function ensureGrid(): void {
  if (grid) return;
  grid = new Uint8Array(GW * GH);

  const uppZ = CITY_WD / CITY_IMG_H;
  const K = CITY_SCALE;
  const stamp = (wx: number, wz: number, r: number, bit: number): void => {
    const gx = (wx - CITY_WX0) / CELL;
    const gz = (wz - CITY_WZ0) / CELL;
    const gr = r / CELL;
    const x0 = Math.max(0, Math.floor(gx - gr));
    const x1 = Math.min(GW - 1, Math.ceil(gx + gr));
    const z0 = Math.max(0, Math.floor(gz - gr));
    const z1 = Math.min(GH - 1, Math.ceil(gz + gr));
    const r2 = gr * gr;
    for (let z = z0; z <= z1; z++) {
      const dz = z - gz;
      const row = z * GW;
      for (let x = x0; x <= x1; x++) {
        const dx = x - gx;
        if (dx * dx + dz * dz <= r2) grid[row + x] |= bit;
      }
    }
  };

  for (const p of CITY_PATHS) {
    const roadR = cityRoadWU(p.w) / 2;
    const walkR = roadR + citySidewalkExtra(p.cls);
    // stamp spacing follows the NARROWEST disc so even the thinnest
    // traced lanes stay contiguous (spacing <= road radius)
    const spacing = Math.max(24, Math.min(CELL * 0.8, roadR));
    let px = CITY_WX0 + p.pts[0] * CITY_UPP;
    let pz = CITY_WZ0 + p.pts[1] * uppZ;
    stamp(px, pz, walkR, WALK_BIT);
    stamp(px, pz, roadR, ROAD_BIT);
    for (let i = 2; i < p.pts.length; i += 2) {
      const nx = CITY_WX0 + p.pts[i] * CITY_UPP;
      const nz = CITY_WZ0 + p.pts[i + 1] * uppZ;
      const len = Math.hypot(nx - px, nz - pz);
      const steps = Math.max(1, Math.ceil(len / spacing));
      for (let s = 1; s <= steps; s++) {
        const sx = px + ((nx - px) * s) / steps;
        const sz = pz + ((nz - pz) * s) / steps;
        stamp(sx, sz, walkR, WALK_BIT);
        stamp(sx, sz, roadR, ROAD_BIT);
      }
      px = nx;
      pz = nz;
    }
  }

  for (const ra of CITY_ROUNDABOUTS) {
    const wx = CITY_WX0 + ra[0] * CITY_UPP;
    const wz = CITY_WZ0 + ra[1] * uppZ;
    const ru = ra[2] * CITY_UPP;
    stamp(wx, wz, ru + 26 * K, WALK_BIT);
    stamp(wx, wz, ru + 14 * K, ROAD_BIT);
    // the sunken grass island inside real roundabouts (its own cube
    // height — the player spawns beside the central one)
    if (ru > 30 * K) stamp(wx, wz, ru - 15 * K, ISLAND_BIT);
  }
}

/* ------------------------------ queries --------------------------------- */

export type CityRoadClass = 0 | 1 | 2 | 3;

/** 0 = plain plateau, 1 = kerbed walkway, 2 = asphalt road deck,
 *  3 = roundabout grass island. */
export function cityRoadClassAt(wx: number, wz: number): CityRoadClass {
  if (!(wx >= CITY_WX0) || !(wx < CITY_WX1) || !(wz >= CITY_WZ0) || !(wz < CITY_WZ1)) {
    return 0; // outside the plateau rect (also catches NaN)
  }
  ensureGrid();
  const g = grid as Uint8Array; // ensureGrid filled it
  const gx = Math.min(GW - 1, Math.max(0, ((wx - CITY_WX0) / CELL) | 0));
  const gz = Math.min(GH - 1, Math.max(0, ((wz - CITY_WZ0) / CELL) | 0));
  const v = g[gz * GW + gx];
  if (v & ISLAND_BIT) return 3;
  if (v & ROAD_BIT) return 2;
  if (v & WALK_BIT) return 1;
  return 0;
}

/** Total surface lift at a world position (0 = untouched nature; inside
 *  the plateau: base quad + walkway/road deck where present). Add this
 *  to terrain.surfaceYAt() to stand on the real city. */
export function citySurfaceLiftAt(wx: number, wz: number): number {
  if (wx < CITY_WX0 || wx >= CITY_WX1 || wz < CITY_WZ0 || wz >= CITY_WZ1) {
    return 0;
  }
  const cls = cityRoadClassAt(wx, wz);
  if (cls === 2) return CITY_QUAD_LIFT + CITY_ROAD_RISE;
  if (cls === 3) return CITY_QUAD_LIFT + CITY_ISLAND_RISE;
  if (cls === 1) return CITY_QUAD_LIFT + CITY_WALK_RISE;
  return CITY_QUAD_LIFT;
}

/** Grid summary for the debug handle (built lazily). */
export function citySurfaceStats(): {
  cell: number;
  grid: string;
  roadCells: number;
  walkCells: number;
  islandCells: number;
} {
  ensureGrid();
  const g = grid as Uint8Array; // ensureGrid filled it
  let roadCells = 0;
  let walkCells = 0;
  let islandCells = 0;
  for (let i = 0; i < g.length; i++) {
    const v = g[i];
    if (v & ISLAND_BIT) islandCells++;
    else if (v & ROAD_BIT) roadCells++;
    else if (v & WALK_BIT) walkCells++;
  }
  return { cell: CELL, grid: `${GW}x${GH}`, roadCells, walkCells, islandCells };
}
