/**
 * CITY LAYOUT — shared constants + pure helpers for the big city road-map
 * plateau (the user's reference map cloned 1:1 into the grassland).
 *
 * The city is a 48x32-BLOCK rectangle of dead-flat ground in open
 * grassland, far from every landmark (oasis 142+ blocks clear, spawn
 * 385 blocks away — probed against every biome hand-zone). Everything
 * here is PURE MATH (no three.js) so the terrain height field, the
 * decor blockers, the minimap and the city builder itself can all
 * agree on one truth:
 *
 *  - cityEdgeT(gx, gz)        0 = plateau core, 1 = untouched nature,
 *                             smoothstep skirt between (terrainChunks
 *                             blends the height field with it)
 *  - cityColumnBlocked(gx,gz) the plateau core rect — decor systems
 *                             (loot chests, ground puddles) are kept out
 *  - cityMinimapTint(gx, gz)  road/walkway tint for the minimap canvas
 */

import {
  CITY_PATHS,
  CITY_ROUNDABOUTS,
  CITY_IMG_W,
  CITY_IMG_H,
} from './cityRoadmapData';

/** The plateau core rect, INCLUSIVE grid blocks — THE DOUBLED GIANT:
 *  768 wide x 512 deep (2x the giant build in each axis, 4x the area)
 *  — 76,800 x 51,200 world units = ~7 km x ~4.7 km (~32 km²) of city at
 *  the game's own toM() scale. The rect moved to a far-south grassland
 *  pocket (centre column 703,-1753, ~1900 blocks SSE of spawn): a
 *  768x512 window probed clear of EVERY biome hand-zone (volcano-S
 *  clears 38 blocks west, cherry-ESE 17 blocks north, crimson-SE 76
 *  blocks north — the old neighbourhood simply has no hole this big:
 *  the mesa showcase starts at gx>=691 and the oasis riser ends at
 *  gx<=164, leaving only ~520 clear blocks between them). Terrain
 *  forces grassland inside the rect, so any natural biome country
 *  rolling underneath still reads as clean city ground. */
export const CITY_GRID = {
  gx0: 319,
  gx1: 1086,
  gz0: -2009,
  gz1: -1498,
  /** Smooth skirt band around the core, in blocks. */
  blend: 7,
  /** Plateau level sample column (baseHeight here = the city's Y). */
  cxgx: 703,
  cxgz: -1753,
} as const;

/** Linear scale factor vs the original traced mapping (1 image px now
 *  spans 16x more world than the flat map) — marking sizes, sidewalk
 *  extras and the roundabout pads multiply by this so the network
 *  grows as ONE giant coherent map. */
export const CITY_SCALE = 16;
export const CITY_BLOCK = 100;
export const CITY_GRID_OFFSET = 64;

/** Extra road widening ON TOP of the 2x map doubling — the traced
 *  widths already grow 2x with the rect; this stretches every car-
 *  riageway a further 25% so the wider roads read unmistakably. */
export const CITY_ROAD_W_MULT = 1.25;

/** Road deck width in world units for a path of `pxW` reference-image
 *  pixels (traced width x UPP x the extra widening). ONE truth used by
 *  the physics raster, the minimap raster and the marking pass — the
 *  visible cube deck samples the same raster, so everything agrees. */
export function cityRoadWU(pxW: number): number {
  return pxW * CITY_UPP * CITY_ROAD_W_MULT;
}

/** World-space rect of the plateau core. */
export const CITY_WX0 = (CITY_GRID.gx0 - CITY_GRID_OFFSET) * CITY_BLOCK; // 25500
export const CITY_WX1 = (CITY_GRID.gx1 + 1 - CITY_GRID_OFFSET) * CITY_BLOCK; // 102300
export const CITY_WZ0 = (CITY_GRID.gz0 - CITY_GRID_OFFSET) * CITY_BLOCK; // -207300
export const CITY_WZ1 = (CITY_GRID.gz1 + 1 - CITY_GRID_OFFSET) * CITY_BLOCK; // -156100
export const CITY_WW = CITY_WX1 - CITY_WX0; // 76800
export const CITY_WD = CITY_WZ1 - CITY_WZ0; // 51200
export const CITY_WCX = (CITY_WX0 + CITY_WX1) / 2; // 63900
export const CITY_WCZ = (CITY_WZ0 + CITY_WZ1) / 2; // -181700

function smoothstep01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** Plateau blend factor at a grid column: 0 = fully flat city core,
 *  1 = natural terrain beyond the skirt. Cheap rect-distance math —
 *  this runs for every column the terrain builds. */
export function cityEdgeT(gx: number, gz: number): number {
  const dx =
    gx < CITY_GRID.gx0
      ? CITY_GRID.gx0 - gx
      : gx > CITY_GRID.gx1
        ? gx - CITY_GRID.gx1
        : 0;
  const dz =
    gz < CITY_GRID.gz0
      ? CITY_GRID.gz0 - gz
      : gz > CITY_GRID.gz1
        ? gz - CITY_GRID.gz1
        : 0;
  const d = Math.max(dx, dz);
  if (d <= 0) return 0;
  return smoothstep01(d / CITY_GRID.blend);
}

/** Decor blocker: true inside the plateau core (+1 block apron) —
 *  loot chests and ground puddles must not spawn on the roads. */
export function cityColumnBlocked(gx: number, gz: number): boolean {
  return (
    gx >= CITY_GRID.gx0 - 1 &&
    gx <= CITY_GRID.gx1 + 1 &&
    gz >= CITY_GRID.gz0 - 1 &&
    gz <= CITY_GRID.gz1 + 1
  );
}

/* ------------------------ minimap road raster ------------------------ */
/* Rasterize the vectorized road network once into a 4x-supersampled
 * grid over the plateau rect; three lazily-built Uint8 layers answer
 * per-block tint queries for the minimap canvas. Pure math, no DOM. */

const SUB = 1; // 1 sample per block centre — EXACTLY the cube-deck rule
const GW = (CITY_GRID.gx1 - CITY_GRID.gx0 + 1) * SUB; // 768
const GH = (CITY_GRID.gz1 - CITY_GRID.gz0 + 1) * SUB; // 512

let roadGrid: Uint8Array | null = null;
let walkGrid: Uint8Array | null = null;

/** World units per reference image pixel. */
export const CITY_UPP = CITY_WW / CITY_IMG_W; // 50

function imageToWorld(px: number, py: number): [number, number] {
  return [
    CITY_WX0 + (px / CITY_IMG_W) * CITY_WW,
    CITY_WZ0 + (py / CITY_IMG_H) * CITY_WD,
  ];
}

/** Sidewalk (footpath) extra width each side of a road, world units —
 *  scaled with the giant build so the kerbed footpaths grow with it. */
export function citySidewalkExtra(cls: number): number {
  const base = cls === 2 ? 36 : cls === 1 ? 24 : 18;
  return base * CITY_SCALE;
}

function ensureGrids(): void {
  if (roadGrid) return;
  roadGrid = new Uint8Array(GW * GH);
  walkGrid = new Uint8Array(GW * GH);
  // walkway = road dilated by its sidewalk extra — rasterize per path
  // into walk first, then roads into road (roads overwrite walk centre)
  const mark = (
    grid: Uint8Array,
    pts: number[],
    halfWu: number
  ): void => {
    // walk the polyline stamping discs of halfWu
    const half = halfWu / CITY_BLOCK * SUB; // subcells
    let pxw = 0;
    let pyw = 0;
    for (let i = 0; i < pts.length; i += 2) {
      const [wx, wz] = imageToWorld(pts[i], pts[i + 1]);
      const cx = ((wx - CITY_WX0) / CITY_BLOCK) * SUB;
      const cy = ((wz - CITY_WZ0) / CITY_BLOCK) * SUB;
      if (i > 0) {
        const dx = cx - pxw;
        const dy = cy - pyw;
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
        for (let s = 0; s <= steps; s++) {
          const sx = pxw + (dx * s) / steps;
          const sy = pyw + (dy * s) / steps;
          const x0 = Math.max(0, Math.floor(sx - half));
          const x1 = Math.min(GW - 1, Math.ceil(sx + half));
          const y0 = Math.max(0, Math.floor(sy - half));
          const y1 = Math.min(GH - 1, Math.ceil(sy + half));
          const h2 = half * half;
          for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
              const ddx = x - sx;
              const ddy = y - sy;
              if (ddx * ddx + ddy * ddy <= h2) grid[y * GW + x] = 1;
            }
          }
        }
      }
      pxw = cx;
      pyw = cy;
    }
  };
  for (const p of CITY_PATHS) {
    mark(
      walkGrid,
      p.pts,
      cityRoadWU(p.w) / 2 + citySidewalkExtra(p.cls)
    );
  }
  for (const p of CITY_PATHS) {
    mark(roadGrid, p.pts, cityRoadWU(p.w) / 2);
  }
  for (const ra of CITY_ROUNDABOUTS) {
    const [wx, wz] = imageToWorld(ra[0], ra[1]);
    const cx = ((wx - CITY_WX0) / CITY_BLOCK) * SUB;
    const cy = ((wz - CITY_WZ0) / CITY_BLOCK) * SUB;
    const rr = (ra[2] * CITY_UPP * 1.6) / CITY_BLOCK * SUB;
    const rrW = (ra[2] * CITY_UPP) / CITY_BLOCK * SUB;
    const x0 = Math.max(0, Math.floor(cx - rr));
    const x1 = Math.min(GW - 1, Math.ceil(cx + rr));
    const y0 = Math.max(0, Math.floor(cy - rr));
    const y1 = Math.min(GH - 1, Math.ceil(cy + rr));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d2 <= rr * rr) walkGrid![y * GW + x] = 1;
        if (d2 <= rrW * rrW) roadGrid![y * GW + x] = 1;
      }
    }
  }
}

/** Minimap tint at a grid block: 'road' (dark asphalt), 'walk'
 *  (stone walkway) or null (keep the biome colour). */
export function cityMinimapTint(
  gx: number,
  gz: number
): 'road' | 'walk' | null {
  if (
    gx < CITY_GRID.gx0 ||
    gx > CITY_GRID.gx1 ||
    gz < CITY_GRID.gz0 ||
    gz > CITY_GRID.gz1
  ) {
    return null;
  }
  ensureGrids();
  const lx = gx - CITY_GRID.gx0;
  const lz = gz - CITY_GRID.gz0;
  // SUB=1: the block's centre sample — the exact rule the visible
  // cube deck uses, so the minimap always matches what is built
  let roadN = 0;
  let walkN = 0;
  for (let sy = 0; sy < SUB; sy++) {
    for (let sx = 0; sx < SUB; sx++) {
      const idx = (lz * SUB + sy) * GW + (lx * SUB + sx);
      if (roadGrid![idx]) roadN++;
      if (walkGrid![idx]) walkN++;
    }
  }
  if (roadN >= SUB * SUB * 0.5) return 'road';
  if (walkN >= 1) return 'walk';
  return null;
}
