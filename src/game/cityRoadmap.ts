/**
 * CITY ROADMAP — the user's reference city map cloned 1:1 into the
 * grassland (see src/game/cityLayout.ts for the plateau rect and
 * src/game/cityRoadmapData.ts for the vectorized network).
 *
 *  - THE PLATEAU: terrainChunks blends a 768x512-block rectangle of dead
 *    flat grass into the height field (cityEdgeT skirt) — 76,800 x
 *    51,200 world units (~7 km x ~4.7 km, ~32 km² at the game's own
 *    toM() scale) carrying ONE giant painted base quad (grass + water
 *    between the blocks) — a single draw call.
 *  - THE CUBE ROAD DECK: the whole road map is built from REAL CUBE
 *    BLOCKS — the same 100u voxel cubes as every terrain block, in
 *    THREE different textures: ASPHALT cubes form the road decks (one
 *    block above the ground), ROCK cubes form the kerbed footpaths
 *    (ONE BLOCK HIGHER than the road cubes, like real raised
 *    sidewalks), GRASS cubes fill the roundabout islands — plus raised
 *    WHITE marking blocks on the road cubes (dashed centre lines,
 *    zebra crossings, direction arrows, runway dashes + piano keys).
 *    The cube field is sampled from the same block raster the physics
 *    answers from (cityRoadSurface.ts) — what you see is EXACTLY what
 *    you stand on. One merged geometry per material — 4 draw calls.
 *  - THE BAKE: a 3840x2560 canvas (1920x1280 on low-spec) paints, in
 *    order: the GRASS BASE (the real minecraft atlas top tile, so the
 *    quad blends seamlessly with the surrounding biome) and the blue
 *    water rects traced from the reference — everything else on the
 *    map is REAL CUBES (the bake is deliberately light: the deck's
 *    blocks carry all roads/walks/markings now).
 *  - THE TEXTURES: four deterministic 16x16 voxel tiles (grass / rock
 *    / asphalt / white paint) are upscaled to one block (100u) and
 *    used as repeating canvas patterns — every marking is literally
 *    textured with the white tile, every road with the asphalt tile,
 *    every footpath with the rock tile, per the brief.
 *  - ZERO PER-FRAME COST: the whole city is one static mesh; nothing
 *    updates. The atlas image loads asynchronously and re-bakes the
 *    grass base once, so the base is pixel-identical to the terrain.
 */

import * as THREE from 'three';
import {
  CITY_PATHS,
  CITY_ROUNDABOUTS,
  CITY_JUNCTIONS,
  CITY_WATER,
  CITY_IMG_W,
  CITY_IMG_H,
  type CityPath,
} from './cityRoadmapData';
import {
  CITY_BLOCK,
  CITY_GRID,
  CITY_GRID_OFFSET,
  CITY_SCALE,
  CITY_WX0,
  CITY_WZ0,
  CITY_WW,
  CITY_WD,
  CITY_WCX,
  CITY_WCZ,
  CITY_UPP,
  cityRoadWU,
} from './cityLayout';
import {
  CITY_ISLAND_RISE,
  CITY_MARK_H,
  CITY_QUAD_LIFT,
  CITY_ROAD_RISE,
  CITY_WALK_RISE,
  cityRoadClassAt,
  citySurfaceStats,
  type CityRoadClass,
} from './cityRoadSurface';

/* ------------------------------ tuning ---------------------------------- */

/** Bake canvas width in px (height follows the 3:2 map aspect). */
const BAKE_W = 3840;
const BAKE_W_LOWSPEC = 1920;

/* --- marking geometry (world units, pre-scaled for the giant city) --- */
const K = CITY_SCALE;
const DASH_LEN = 62 * K;
const DASH_PERIOD = 112 * K;
const RUNWAY_DASH_LEN = 110 * K;
const RUNWAY_DASH_PERIOD = 235 * K;
const DASH_MIN_ROAD_W = 42 * K; // dashes only on roads at least this wide
const ZEBRA_BAND_OFF = 95 * K; // band centre beyond the roundabout radius
const ZEBRA_BAR = 10 * K; // bar thickness along the road
const ZEBRA_PITCH = 18 * K; // bar spacing along the road
const ZEBRA_COUNT = 3;
const ARROW_PERIOD = 340 * K;
const ARROW_MIN_ROAD_W = 42 * K;

/** Deterministic PRNG so every boot paints identical tiles. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * THE FOUR 16x16 VOXEL TILES (painted dark — the world's sun +
 * ambient lift ~1.9x, same convention as the terrain atlases)
 * ------------------------------------------------------------------ */

function makeTile(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 16;
  return [c, c.getContext('2d') as CanvasRenderingContext2D];
}

function paintNoise(
  ctx: CanvasRenderingContext2D,
  rand: () => number,
  base: [number, number, number],
  jitter: number,
  flecks: Array<{ col: string; n: number }>
): void {
  const [r, g, b] = base;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const j = Math.round((rand() - 0.5) * 2 * jitter);
      ctx.fillStyle = `rgb(${r + j},${g + j},${b + j})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  for (const f of flecks) {
    for (let i = 0; i < f.n; i++) {
      ctx.fillStyle = f.col;
      ctx.fillRect((rand() * 16) | 0, (rand() * 16) | 0, 1, 1);
    }
  }
}

/** ASPHALT — dark speckled road surface. */
function paintAsphalt(ctx: CanvasRenderingContext2D): void {
  const rand = mulberry32(0xc17c0ad >>> 0);
  paintNoise(ctx, rand, [35, 35, 40], 5, [
    { col: '#43434b', n: 12 },
    { col: '#26262c', n: 12 },
    { col: '#4c4c55', n: 4 },
  ]);
}

/** ROCK — minecraft-style cobblestone footpath tile: stone blobs with
 *  darker mortar seams and per-texel shade jitter. */
function paintRock(ctx: CanvasRenderingContext2D): void {
  const rand = mulberry32(0x5c17705 >>> 0);
  // mortar base
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const j = Math.round((rand() - 0.5) * 8);
      ctx.fillStyle = `rgb(${44 + j},${44 + j},${46 + j})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  // stones: rounded blobs of 2x2..4x3 with a shade per stone + noise
  const stones: Array<[number, number, number, number]> = [
    [0, 0, 5, 4], [6, 0, 5, 3], [12, 0, 4, 4],
    [0, 5, 4, 4], [5, 4, 6, 5], [12, 5, 4, 3],
    [0, 10, 6, 3], [7, 10, 4, 3], [12, 9, 4, 4],
    [0, 14, 4, 2], [5, 14, 6, 2], [12, 14, 4, 2],
  ];
  for (const [sx, sy, sw, sh] of stones) {
    const shade = 74 + Math.round(rand() * 18);
    for (let y = sy; y < sy + sh; y++) {
      for (let x = sx; x < sx + sw; x++) {
        // rounded corners stay mortar
        const cx = x - sx - (sw - 1) / 2;
        const cy = y - sy - (sh - 1) / 2;
        if (Math.abs(cx) > sw / 2 - 0.7 && Math.abs(cy) > sh / 2 - 0.7) {
          continue;
        }
        const j = Math.round((rand() - 0.5) * 14);
        ctx.fillStyle = `rgb(${shade + j},${shade + j},${shade + 2 + j})`;
        ctx.fillRect(x & 15, y & 15, 1, 1);
      }
    }
    // top-left highlight
    ctx.fillStyle = 'rgba(160,160,164,0.5)';
    ctx.fillRect(sx & 15, sy & 15, Math.min(sw, 3), 1);
  }
}

/** MARK — the white theme paint tile for every road marking. */
function paintMark(ctx: CanvasRenderingContext2D): void {
  const rand = mulberry32(0x0ffffa7 >>> 0);
  paintNoise(ctx, rand, [206, 210, 206], 4, [
    { col: '#c2c6c2', n: 8 },
  ]);
}

/** GRASS fallback — close replica of the atlas top tile palette, used
 *  until the real atlas image loads (then the base is re-baked from it
 *  so the blend with the biome is pixel-perfect). */
function paintGrassFallback(ctx: CanvasRenderingContext2D): void {
  const rand = mulberry32(0x6ea55e5 >>> 0);
  const palette = [
    '#507208', '#396202', '#255401', '#496d03',
    '#2a5600', '#224e01', '#5f7e0b', '#396202',
  ];
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      ctx.fillStyle = palette[(rand() * palette.length) | 0];
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

/** Paint the REAL atlas grass top tile (16x16 top half of the 16x32
 *  atlas the terrain chunks use — pixel-identical ground). */
function paintGrassFromAtlas(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement
): void {
  ctx.clearRect(0, 0, 16, 16);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, 16, 16, 0, 0, 16, 16);
}

/** Nearest-neighbour upscale of a 16x16 tile to `px` (one block). */
function upscaleTile(src: HTMLCanvasElement, px: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = px;
  c.height = px;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, 16, 16, 0, 0, px, px);
  return c;
}

/* ------------------------------------------------------------------ *
 * THE DECK GEOMETRY BUILDER — a minimal world-space accumulator that
 * merges every slab/wall/disc into ONE BufferGeometry per material.
 * Corner orders at the call sites are pre-verified windings: quad()
 * derives its flat normal from (b-a)x(c-a), so callers pass corners
 * counter-clockwise seen from the visible side.
 * ------------------------------------------------------------------ */

class GeoBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private uv: number[] = [];
  private idx: number[] = [];
  private v = 0;

  get tris(): number {
    return this.idx.length / 3;
  }

  /** One flat triangle with an explicit normal. */
  tri(
    a: number[],
    ua: number[],
    b: number[],
    ub: number[],
    c: number[],
    uc: number[],
    n: number[]
  ): void {
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let i = 0; i < 3; i++) this.nor.push(n[0], n[1], n[2]);
    this.uv.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
    const v = this.v;
    this.idx.push(v, v + 1, v + 2);
    this.v += 3;
  }

  /** Planar quad a-b-c-d (consistent winding) — emits two triangles
   *  sharing one flat normal. FOUR shared vertices + 6 indices (half
   *  the vertex memory of the naive 6-vertex emit — the doubled city
   *  builds ~4x the cubes of the giant build). */
  quad(
    a: number[],
    ua: number[],
    b: number[],
    ub: number[],
    c: number[],
    uc: number[],
    d: number[],
    ud: number[]
  ): void {
    const e1x = b[0] - a[0];
    const e1y = b[1] - a[1];
    const e1z = b[2] - a[2];
    const e2x = c[0] - a[0];
    const e2y = c[1] - a[1];
    const e2z = c[2] - a[2];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    for (let i = 0; i < 4; i++) this.nor.push(nx, ny, nz);
    this.uv.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1], ud[0], ud[1]);
    const v = this.v;
    this.idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    this.v += 4;
  }

  /** Merged BufferGeometry (or null when nothing was pushed). */
  build(): THREE.BufferGeometry | null {
    if (this.v === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    return g;
  }
}

/* ------------------------------ types ----------------------------------- */

export interface CityRoadmapHandle {
  /** City centre + quad top Y (debug handle). */
  layout(): { x: number; z: number; topY: number; w: number; d: number };
  /** Surface class under a world point — 0 plain plateau, 1 kerbed
   *  walkway, 2 asphalt deck, 3 roundabout grass island (the same
   *  truth the physics lift in cityRoadSurface.ts answers from). */
  roadClassAt(x: number, z: number): CityRoadClass;
  /** Bake + deck summary (debug handle). */
  stats(): {
    paths: number;
    roundabouts: number;
    canvas: string;
    dashes: number;
    zebras: number;
    arrows: number;
    /** 3D cube deck: merged triangles, marking blocks, cubes. */
    tris3d: number;
    marks3d: number;
    cubes3d: number;
    surface: ReturnType<typeof citySurfaceStats>;
  };
  dispose(): void;
}

/* ------------------------------ builder --------------------------------- */

export function createCityRoadmap(
  scene: THREE.Scene,
  opts: {
    block: number;
    lowSpec?: boolean;
    /** Top-face Y of the flattened plateau (terrain.cityTopY()). */
    plateauTopY: number;
  }
): CityRoadmapHandle {
  const block = opts.block;
  const bakeW = opts.lowSpec ? BAKE_W_LOWSPEC : BAKE_W;
  const bakeH = Math.round((bakeW * CITY_WD) / CITY_WW);
  const S = bakeW / CITY_WW; // canvas px per world unit
  const tilePx = Math.max(8, Math.round(block * S)); // one block per tile

  /* -------- world <-> canvas helpers -------- */
  // image pixel -> world
  const uppZ = CITY_WD / CITY_IMG_H;
  const iw = (px: number): number => CITY_WX0 + px * CITY_UPP;
  const iz = (py: number): number => CITY_WZ0 + py * uppZ;
  // world -> canvas
  const cx = (wx: number): number => (wx - CITY_WX0) * S;
  const cy = (wz: number): number => (wz - CITY_WZ0) * S;

  /* -------- the grass tile + pattern -------- */
  const [grassTile, grassCtx] = makeTile();
  paintGrassFallback(grassCtx);

  const bake = document.createElement('canvas');
  bake.width = bakeW;
  bake.height = bakeH;
  const ctx = bake.getContext('2d') as CanvasRenderingContext2D;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  let grassPattern: CanvasPattern;

  /* -------- counters (debug) -------- */
  let dashCount = 0;
  let zebraCount = 0;
  let arrowCount = 0;

  /** Polyline -> world-unit segments with cumulative arclength. */
  interface Seg {
    x0: number;
    z0: number;
    dx: number;
    dz: number;
    len: number;
    h: number; // heading (atan2(dz, dx), world frame)
  }
  function buildSegs(pts: number[]): { segs: Seg[]; total: number } {
    const segs: Seg[] = [];
    let total = 0;
    for (let i = 0; i < pts.length - 2; i += 2) {
      const x0 = iw(pts[i]);
      const z0 = iz(pts[i + 1]);
      const x1 = iw(pts[i + 2]);
      const z1 = iz(pts[i + 3]);
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      segs.push({ x0, z0, dx, dz, len, h: Math.atan2(dz, dx) });
      total += len;
    }
    return { segs, total };
  }
  function posAt(segs: Seg[], s: number): { x: number; z: number; h: number } {
    let acc = 0;
    for (const g of segs) {
      if (s <= acc + g.len || g === segs[segs.length - 1]) {
        const t = Math.min(1, Math.max(0, (s - acc) / g.len));
        return { x: g.x0 + g.dx * t, z: g.z0 + g.dz * t, h: g.h };
      }
      acc += g.len;
    }
    const g = segs[segs.length - 1];
    return { x: g.x0 + g.dx, z: g.z0 + g.dz, h: g.h };
  }
  function cornerAt(segs: Seg[], s: number, span: number): number {
    const a = posAt(segs, Math.max(0, s - span)).h;
    const b = posAt(segs, s + span).h;
    let d = Math.abs(b - a);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  }

  /* -------- skip-zone tables (world units) -------- */
  const jxw = CITY_JUNCTIONS.map(([jx, jy]) => ({ x: iw(jx), z: iz(jy) }));
  const raws = CITY_ROUNDABOUTS.map(([rx, ry, rr]) => ({
    x: iw(rx),
    z: iz(ry),
    rpx: rr,
    ru: rr * CITY_UPP,
  }));
  function nearJunction(x: number, z: number, r: number): boolean {
    for (const j of jxw) {
      const dx = j.x - x;
      const dz = j.z - z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }
  function nearRoundabout(x: number, z: number, pad: number): number {
    // returns the closest roundabout radius (or -1)
    let best = -1;
    for (const ra of raws) {
      const dx = ra.x - x;
      const dz = ra.z - z;
      const d2 = dx * dx + dz * dz;
      const rr = ra.ru + pad;
      if (d2 < rr * rr && ra.ru > best) best = ra.ru;
    }
    return best;
  }

  /* ============================ THE BAKE ============================ */

  function rebake(): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bakeW, bakeH);

    // tile pattern (rebuilt each bake so the grass tile can swap)
    grassPattern = ctx.createPattern(
      upscaleTile(grassTile, tilePx),
      'repeat'
    ) as CanvasPattern;

    // 1 — GRASS BASE (blends with the surrounding biome). The roads,
    // footpaths and markings are REAL 3D CUBES on top of this — the
    // bake only carries the ground between the blocks + the water.
    ctx.fillStyle = grassPattern;
    ctx.fillRect(0, 0, bakeW, bakeH);

    // 2 — WATER rects traced from the reference (drawn last, on top)
    for (const [wxp, wyp, ww, wh] of CITY_WATER) {
      const x0 = cx(iw(wxp));
      const z0 = cy(iz(wyp));
      ctx.fillStyle = '#1d3f7c';
      ctx.fillRect(x0, z0, ww * CITY_UPP * S, wh * uppZ * S);
      ctx.strokeStyle = '#142c56';
      ctx.lineWidth = 4;
      ctx.strokeRect(x0, z0, ww * CITY_UPP * S, wh * uppZ * S);
    }
  }

  /* -------- texture + mesh -------- */
  const texture = new THREE.CanvasTexture(bake);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter; // crisp voxel texels up close
  texture.minFilter = THREE.LinearMipmapLinearFilter; // calm at distance
  texture.generateMipmaps = true;
  texture.anisotropy = 4;

  rebake();
  texture.needsUpdate = true;

  let disposed = false;

  const geometry = new THREE.PlaneGeometry(CITY_WW, CITY_WD);
  geometry.rotateX(-Math.PI / 2); // lie flat, facing up (oasis-water convention)
  const material = new THREE.MeshLambertMaterial({ map: texture });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(CITY_WCX, opts.plateauTopY + CITY_QUAD_LIFT, CITY_WCZ);
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  scene.add(mesh);

  /* ================== THE CUBE ROAD DECK (real block city) ==================
   * The whole road map is built from REAL CUBE BLOCKS — the same 100u
   * voxel cubes as every terrain block, in THREE different textures:
   *   ASPHALT cubes — the road decks, one block above the ground;
   *   ROCK cubes    — the kerbed footpaths, ONE BLOCK ABOVE the road;
   *   GRASS cubes   — the roundabout islands, at ring level;
   * plus raised WHITE marking blocks on the road cubes (dashed centre
   * lines, zebra crossings, direction arrows, runway dashes + piano
   * keys). The cube field is sampled from the same block raster the
   * physics answers from (cityRoadSurface.ts) — what you see is
   * EXACTLY what you stand on. One merged geometry per material —
   * 4 draw calls, zero per-frame cost. */

  const quadBase = opts.plateauTopY + CITY_QUAD_LIFT;
  const roadTop = opts.plateauTopY + CITY_ROAD_RISE;
  const markTop = roadTop + CITY_MARK_H;
  const markBot = roadTop - 4; // marking blocks sink into the road cubes
  const T3 = CITY_BLOCK; // ONE 16x16 texture per cube face (terrain-style)

  // cube block tiles: the paint tiles + a seam lip so every cube face
  // reads as an individual voxel block (the same aesthetic as terrain)
  const seamify = (c: CanvasRenderingContext2D): void => {
    c.fillStyle = 'rgba(0,0,0,0.38)';
    c.fillRect(15, 0, 1, 16);
    c.fillRect(0, 15, 16, 1);
    c.fillStyle = 'rgba(255,255,255,0.16)';
    c.fillRect(0, 0, 1, 16);
    c.fillRect(0, 0, 16, 1);
  };
  const makeBlockTile = (
    paint: (c: CanvasRenderingContext2D) => void
  ): HTMLCanvasElement => {
    const [tile, tctx] = makeTile();
    paint(tctx);
    seamify(tctx);
    return tile;
  };
  const makeBlockTexture = (tile: HTMLCanvasElement): THREE.CanvasTexture => {
    const t = new THREE.CanvasTexture(tile);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    return t;
  };

  const [grass3DTile, grass3DCtx] = makeTile();
  paintGrassFallback(grass3DCtx);
  seamify(grass3DCtx);
  const asphalt3DTex = makeBlockTexture(makeBlockTile(paintAsphalt));
  const rock3DTex = makeBlockTexture(makeBlockTile(paintRock));
  const mark3DTex = makeBlockTexture(makeBlockTile(paintMark));
  const grass3DTex = makeBlockTexture(grass3DTile);

  const bAsphalt = new GeoBuilder();
  const bWalk = new GeoBuilder();
  const bMark = new GeoBuilder();
  const bGrass = new GeoBuilder();

  const uvw = (x: number, z: number): [number, number] => [x / T3, z / T3];
  const uvy = (h: number, y: number): [number, number] => [h / T3, y / T3];

  /** One terrain-style cube: top face + side walls ONLY where the
   *  neighbouring cube is lower or absent (interior faces are skipped;
   *  a wall's bottom sits at the neighbour's top so no two faces are
   *  ever coplanar). nNX/nPX/nNZ/nPZ = neighbour cube tops. */
  const pushCube = (
    b: GeoBuilder,
    x0: number,
    z0: number,
    y1: number,
    nNX: number,
    nPX: number,
    nNZ: number,
    nPZ: number
  ): void => {
    const x1 = x0 + CITY_BLOCK;
    const z1 = z0 + CITY_BLOCK;
    b.quad(
      [x0, y1, z0], uvw(x0, z0),
      [x0, y1, z1], uvw(x0, z1),
      [x1, y1, z1], uvw(x1, z1),
      [x1, y1, z0], uvw(x1, z0)
    );
    if (nNX < y1 - 2) {
      b.quad(
        [x0, y1, z0], uvy(z0, y1),
        [x0, nNX, z0], uvy(z0, nNX),
        [x0, nNX, z1], uvy(z1, nNX),
        [x0, y1, z1], uvy(z1, y1)
      );
    }
    if (nPX < y1 - 2) {
      b.quad(
        [x1, y1, z1], uvy(z1, y1),
        [x1, nPX, z1], uvy(z1, nPX),
        [x1, nPX, z0], uvy(z0, nPX),
        [x1, y1, z0], uvy(z0, y1)
      );
    }
    if (nNZ < y1 - 2) {
      b.quad(
        [x1, y1, z0], uvy(x1, y1),
        [x1, nNZ, z0], uvy(x1, nNZ),
        [x0, nNZ, z0], uvy(x0, nNZ),
        [x0, y1, z0], uvy(x0, y1)
      );
    }
    if (nPZ < y1 - 2) {
      b.quad(
        [x0, y1, z1], uvy(x0, y1),
        [x0, nPZ, z1], uvy(x0, nPZ),
        [x1, nPZ, z1], uvy(x1, nPZ),
        [x1, y1, z1], uvy(x1, y1)
      );
    }
  };

  /** Marking block: an `along` x `across` white slab centered at
   *  (bx,bz) rotated to heading h — top + 4 walls (no bottom; it sinks
   *  into the road cubes). */
  const pushYawBox = (
    b: GeoBuilder,
    bx: number,
    bz: number,
    h: number,
    along: number,
    across: number,
    yT: number,
    yB: number
  ): void => {
    const ch = Math.cos(h);
    const sh = Math.sin(h);
    const ax = (ch * along) / 2;
    const az = (sh * along) / 2;
    const px = (-sh * across) / 2;
    const pz = (ch * across) / 2;
    const T0 = [bx - ax - px, yT, bz - az - pz];
    const T1 = [bx + ax - px, yT, bz + az - pz];
    const T2 = [bx + ax + px, yT, bz + az + pz];
    const T3c = [bx - ax + px, yT, bz - az + pz];
    const B0 = [T0[0], yB, T0[2]];
    const B1 = [T1[0], yB, T1[2]];
    const B2 = [T2[0], yB, T2[2]];
    const B3 = [T3c[0], yB, T3c[2]];
    const ha = along / 2;
    const hc = across / 2;
    b.quad(
      T0, uvw(T0[0], T0[2]),
      T3c, uvw(T3c[0], T3c[2]),
      T2, uvw(T2[0], T2[2]),
      T1, uvw(T1[0], T1[2])
    );
    b.quad(T3c, uvy(-ha, yT), B3, uvy(-ha, yB), B2, uvy(ha, yB), T2, uvy(ha, yT));
    b.quad(T1, uvy(-ha, yT), B1, uvy(-ha, yB), B0, uvy(ha, yB), T0, uvy(ha, yT));
    b.quad(T2, uvy(-hc, yT), B2, uvy(-hc, yB), B1, uvy(hc, yB), T1, uvy(hc, yT));
    b.quad(T0, uvy(-hc, yT), B0, uvy(-hc, yB), B3, uvy(hc, yB), T3c, uvy(hc, yT));
  };

  let roadCubes = 0;
  let walkCubes = 0;
  let islandCubes = 0;
  let markBoxes = 0;

  /** Cube top at a grid column (or the bare ground when no cube). */
  const blockTop = (gx: number, gz: number): number => {
    if (
      gx < CITY_GRID.gx0 ||
      gx > CITY_GRID.gx1 ||
      gz < CITY_GRID.gz0 ||
      gz > CITY_GRID.gz1
    ) {
      return quadBase - 5;
    }
    const wx = (gx - CITY_GRID_OFFSET) * CITY_BLOCK;
    const wz = (gz - CITY_GRID_OFFSET) * CITY_BLOCK;
    const c = cityRoadClassAt(wx + CITY_BLOCK / 2, wz + CITY_BLOCK / 2);
    if (c === 0) return quadBase - 5;
    return opts.plateauTopY + (c === 1 ? CITY_WALK_RISE : CITY_ROAD_RISE);
  };

  // — THE CUBE FIELD: one pass over the plateau's blocks; the class at
  // each block centre picks the texture + height (footpaths ONE BLOCK
  // above the road cubes, both one/two above the ground) —
  for (let gz = CITY_GRID.gz0; gz <= CITY_GRID.gz1; gz++) {
    for (let gx = CITY_GRID.gx0; gx <= CITY_GRID.gx1; gx++) {
      const wx = (gx - CITY_GRID_OFFSET) * CITY_BLOCK;
      const wz = (gz - CITY_GRID_OFFSET) * CITY_BLOCK;
      const cls = cityRoadClassAt(wx + CITY_BLOCK / 2, wz + CITY_BLOCK / 2);
      if (cls === 0) continue;
      const top =
        opts.plateauTopY +
        (cls === 1
          ? CITY_WALK_RISE
          : cls === 3
            ? CITY_ISLAND_RISE
            : CITY_ROAD_RISE);
      pushCube(
        cls === 1 ? bWalk : cls === 3 ? bGrass : bAsphalt,
        wx,
        wz,
        top,
        blockTop(gx - 1, gz),
        blockTop(gx + 1, gz),
        blockTop(gx, gz - 1),
        blockTop(gx, gz + 1)
      );
      if (cls === 1) walkCubes++;
      else if (cls === 3) islandCubes++;
      else roadCubes++;
    }
  }

  // — dashed centre lines (3D blocks, same placement rules as the bake) —
  for (const p of CITY_PATHS) {
    const roadWu = cityRoadWU(p.w);
    if (p.cls === 2) continue;
    if (roadWu < DASH_MIN_ROAD_W) continue;
    const { segs, total } = buildSegs(p.pts);
    if (segs.length === 0) continue;
    const dashW = Math.min(7 * K, Math.max(4.5 * K, roadWu * 0.1));
    for (let s = DASH_PERIOD * 0.5; s < total - 10 * K; s += DASH_PERIOD) {
      if (cornerAt(segs, s, 30 * K) > 0.85) continue;
      const q = posAt(segs, s);
      if (nearJunction(q.x, q.z, 85 * K)) continue;
      if (nearRoundabout(q.x, q.z, 145 * K) >= 0) continue;
      pushYawBox(bMark, q.x, q.z, q.h, DASH_LEN, dashW, markTop, markBot);
      dashCount++;
      markBoxes++;
    }
  }

  // — runway: long centre dashes + threshold piano keys —
  let runwayPath: CityPath | null = null;
  let runwayLen3d = 0;
  for (const p of CITY_PATHS) {
    if (p.cls !== 2) continue;
    let L = 0;
    for (let i = 0; i < p.pts.length - 2; i += 2) {
      L += Math.hypot(p.pts[i + 2] - p.pts[i], p.pts[i + 3] - p.pts[i + 1]);
    }
    if (L > runwayLen3d) {
      runwayLen3d = L;
      runwayPath = p;
    }
  }
  if (runwayPath) {
    const roadWu = cityRoadWU(runwayPath.w);
    const { segs, total } = buildSegs(runwayPath.pts);
    for (
      let s = RUNWAY_DASH_PERIOD * 0.5;
      s < total - 40 * K;
      s += RUNWAY_DASH_PERIOD
    ) {
      const q = posAt(segs, s);
      pushYawBox(bMark, q.x, q.z, q.h, RUNWAY_DASH_LEN, 7 * K, markTop, markBot);
      dashCount++;
      markBoxes++;
    }
    const bars = Math.max(3, Math.floor((roadWu - 24 * K) / (24 * K)));
    for (const endS of [30 * K, total - 30 * K]) {
      const q = posAt(segs, endS);
      const h = endS < total / 2 ? q.h : q.h + Math.PI;
      for (let i = 0; i < bars; i++) {
        const yOff = (i - (bars - 1) / 2) * 24 * K;
        pushYawBox(
          bMark,
          q.x + Math.cos(h) * 21 * K - Math.sin(h) * yOff,
          q.z + Math.sin(h) * 21 * K + Math.cos(h) * yOff,
          h,
          42 * K,
          11 * K,
          markTop,
          markBot
        );
        markBoxes++;
      }
    }
  }

  // — zebra crossings on every roundabout approach (same spoke rule as
  //  the bake: only radial street endpoints qualify) —
  interface EndPt3D {
    x: number;
    z: number;
    wu: number;
    ox: number;
    oz: number;
  }
  const ends3d: EndPt3D[] = [];
  for (const p of CITY_PATHS) {
    if (p.cls === 2) continue;
    const wu = cityRoadWU(p.w);
    if (wu < 26 * K || wu > 62 * K) continue;
    const n = p.pts.length;
    let dx = p.pts[2] - p.pts[0];
    let dz = p.pts[3] - p.pts[1];
    let L = Math.hypot(dx, dz) || 1;
    ends3d.push({ x: iw(p.pts[0]), z: iz(p.pts[1]), wu, ox: dx / L, oz: dz / L });
    dx = p.pts[n - 4] - p.pts[n - 2];
    dz = p.pts[n - 3] - p.pts[n - 1];
    L = Math.hypot(dx, dz) || 1;
    ends3d.push({
      x: iw(p.pts[n - 2]),
      z: iz(p.pts[n - 1]),
      wu,
      ox: dx / L,
      oz: dz / L,
    });
  }
  const zebraAt3d: Array<{ x: number; z: number }> = [];
  for (const ra of raws) {
    if (ra.rpx < 5.5) continue;
    for (const e of ends3d) {
      const dx = e.x - ra.x;
      const dz = e.z - ra.z;
      const d = Math.hypot(dx, dz);
      if (d < ra.ru + 20 * K || d > ra.ru + 250 * K) continue;
      const ux = dx / d;
      const uz = dz / d;
      if (ux * e.ox + uz * e.oz < 0.55) continue;
      const bx = ra.x + ux * (ra.ru + ZEBRA_BAND_OFF);
      const bz = ra.z + uz * (ra.ru + ZEBRA_BAND_OFF);
      let dup = false;
      for (const z of zebraAt3d) {
        if ((z.x - bx) ** 2 + (z.z - bz) ** 2 < 55 * K * (55 * K)) {
          dup = true;
          break;
        }
      }
      if (dup) continue;
      zebraAt3d.push({ x: bx, z: bz });
      // 3D bars sit ON the deck slab: keep the band inside the road width
      const acrossW = Math.min(e.wu - 4 * K, 62 * K);
      const h = Math.atan2(uz, ux);
      for (let i = 0; i < ZEBRA_COUNT; i++) {
        const off = (i - (ZEBRA_COUNT - 1) / 2) * ZEBRA_PITCH;
        pushYawBox(
          bMark,
          bx + Math.cos(h) * off,
          bz + Math.sin(h) * off,
          h,
          ZEBRA_BAR,
          acrossW,
          markTop,
          markBot
        );
        markBoxes++;
      }
      zebraCount++;
    }
  }

  // — printed direction arrows (stem + blocky head, lane-offset) —
  for (const p of CITY_PATHS) {
    const roadWu = cityRoadWU(p.w);
    if (p.cls === 2 || roadWu < ARROW_MIN_ROAD_W) continue;
    const { segs, total } = buildSegs(p.pts);
    if (segs.length === 0) continue;
    let k = 0;
    for (let s = 190 * K; s < total - 60 * K; s += ARROW_PERIOD, k++) {
      if (cornerAt(segs, s, 90 * K) > 0.5) continue;
      const q = posAt(segs, s);
      if (nearJunction(q.x, q.z, 110 * K)) continue;
      if (nearRoundabout(q.x, q.z, 170 * K) >= 0) continue;
      const side = k % 2 === 0 ? 1 : -1;
      const off = Math.max(0, Math.min(roadWu * 0.24, roadWu / 2 - 19 * K));
      const ax = q.x + -Math.sin(q.h) * side * off;
      const az = q.z + Math.cos(q.h) * side * off;
      const h = side === 1 ? q.h : q.h + Math.PI;
      pushYawBox(
        bMark,
        ax - Math.cos(h) * 11.5 * K,
        az - Math.sin(h) * 11.5 * K,
        h,
        67 * K,
        7 * K,
        markTop,
        markBot
      );
      pushYawBox(
        bMark,
        ax + Math.cos(h) * 37 * K,
        az + Math.sin(h) * 37 * K,
        h,
        30 * K,
        28 * K,
        markTop,
        markBot
      );
      arrowCount++;
      markBoxes += 2;
    }
  }

  // — merge into 4 static meshes —
  const asphalt3DMat = new THREE.MeshLambertMaterial({ map: asphalt3DTex });
  const walk3DMat = new THREE.MeshLambertMaterial({ map: rock3DTex });
  const mark3DMat = new THREE.MeshLambertMaterial({ map: mark3DTex });
  const grass3DMat = new THREE.MeshLambertMaterial({ map: grass3DTex });
  const deckMeshes: THREE.Mesh[] = [];
  const deckMats = [asphalt3DMat, walk3DMat, mark3DMat, grass3DMat];
  const deckTexs = [asphalt3DTex, rock3DTex, mark3DTex, grass3DTex];
  const addDeckMesh = (b: GeoBuilder, mat: THREE.Material): void => {
    const geo = b.build();
    if (!geo) return;
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    scene.add(m);
    deckMeshes.push(m);
  };
  addDeckMesh(bWalk, walk3DMat);
  addDeckMesh(bAsphalt, asphalt3DMat);
  addDeckMesh(bGrass, grass3DMat);
  addDeckMesh(bMark, mark3DMat);

  // swap the deck grass + the bake base to the REAL atlas tile once it
  // streams in (pixel-identical ground everywhere)
  const atlasImg = new Image();
  atlasImg.onload = () => {
    if (disposed) return;
    paintGrassFromAtlas(grassCtx, atlasImg);
    paintGrassFromAtlas(grass3DCtx, atlasImg);
    seamify(grass3DCtx);
    grass3DTex.needsUpdate = true;
    rebake();
    texture.needsUpdate = true;
  };
  atlasImg.src = '/textures/minecraft/atlas.png';

  /* -------- handle -------- */
  function layout(): {
    x: number;
    z: number;
    topY: number;
    w: number;
    d: number;
  } {
    return {
      x: CITY_WCX,
      z: CITY_WCZ,
      topY: opts.plateauTopY,
      w: CITY_WW,
      d: CITY_WD,
    };
  }

  function roadClassAt(x: number, z: number): CityRoadClass {
    return cityRoadClassAt(x, z);
  }

  function stats(): {
    paths: number;
    roundabouts: number;
    canvas: string;
    dashes: number;
    zebras: number;
    arrows: number;
    tris3d: number;
    marks3d: number;
    cubes3d: number;
    surface: ReturnType<typeof citySurfaceStats>;
  } {
    return {
      paths: CITY_PATHS.length,
      roundabouts: CITY_ROUNDABOUTS.length,
      canvas: `${bakeW}x${bakeH}`,
      dashes: dashCount,
      zebras: zebraCount,
      arrows: arrowCount,
      tris3d: bAsphalt.tris + bWalk.tris + bMark.tris + bGrass.tris,
      marks3d: markBoxes,
      cubes3d: roadCubes + walkCubes + islandCubes,
      surface: citySurfaceStats(),
    };
  }

  function dispose(): void {
    disposed = true;
    mesh.removeFromParent();
    geometry.dispose();
    material.map?.dispose();
    material.dispose();
    for (const m of deckMeshes) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    for (const mat of deckMats) mat.dispose();
    for (const t of deckTexs) t.dispose();
  }

  return { layout, roadClassAt, stats, dispose };
}
