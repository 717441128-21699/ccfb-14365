/**
 * 程序化地形：值噪声生成草地/泥地/森林/丘陵，一条横向河流切开地图，
 * 河上两座窄桥是唯一的通行点。地形按 2m 方格存储，同时供寻路与速度修正使用。
 */
import type { Terrain, TerrainType } from './types';
import { Rng, ValueNoise2D, clamp } from './math';

export const TERRAIN_COST: Record<TerrainType, number> = {
  grass: 1,
  road: 0.85,
  bridge: 1,
  mud: 1.9,
  forest: 2.6,
  hill: 1.5,
  water: Infinity
};

/** 各地形对单位移速的乘区 */
export const TERRAIN_SPEED_FACTOR: Record<TerrainType, number> = {
  grass: 1,
  road: 1.12,
  bridge: 0.95,
  mud: 0.62,
  forest: 0.55,
  hill: 0.78,
  water: 0
};

export function generateTerrain(seed: number, width = 130, height = 90): Terrain {
  const cellSize = 2;
  const cols = Math.ceil(width / cellSize);
  const rows = Math.ceil(height / cellSize);
  const cell = new Uint8Array(cols * rows);
  const noise = new ValueNoise2D(seed);
  const rng = new Rng(seed ^ 0x9e3779b9);

  // 河流：中心线带轻微正弦摆动，宽约 7m
  const riverY = height * 0.52;
  const riverHalf = 3.4;
  const riverCenterAt = (x: number): number =>
    riverY + Math.sin(x * 0.055 + seed * 0.01) * 2.2 + Math.sin(x * 0.13) * 0.8;

  // 两座桥：宽度 6m（恰好只能让纵队通过——典型方阵正面 12m+）
  const bridgeW = 6;
  const b1x = width * 0.3 + rng.range(-4, 4);
  const b2x = width * 0.72 + rng.range(-4, 4);
  const bridges = [
    { x0: b1x - bridgeW / 2, x1: b1x + bridgeW / 2 },
    { x0: b2x - bridgeW / 2, x1: b2x + bridgeW / 2 }
  ];

  // 两条土路：从左右底边通向桥头（简化为直线带状）
  const roads = bridges.map((b) => ({ x: (b.x0 + b.x1) / 2 }));

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const wx = (cx + 0.5) * cellSize;
      const wy = (cy + 0.5) * cellSize;
      const n = noise.fbm(wx * 0.045, wy * 0.045, 3);
      let t: TerrainType;
      if (n < 0.32) t = 'forest';
      else if (n < 0.43) t = 'mud';
      else if (n > 0.66) t = 'hill';
      else t = 'grass';

      // 道路覆盖
      for (const r of roads) {
        if (Math.abs(wx - r.x) < 2.2) t = 'road';
      }

      // 河流覆盖
      const rc = riverCenterAt(wx);
      if (Math.abs(wy - rc) <= riverHalf) {
        const onBridge = bridges.some((b) => wx >= b.x0 && wx <= b.x1);
        t = onBridge ? 'bridge' : 'water';
      }
      cell[cy * cols + cx] = TERRAIN_IDS.indexOf(t);
    }
  }

  return { width, height, cell, cellSize, cols, rows, riverY, bridges };
}

const TERRAIN_IDS: TerrainType[] = [
  'grass', 'mud', 'forest', 'hill', 'water', 'bridge', 'road'
];

export function terrainAt(t: Terrain, x: number, y: number): TerrainType {
  const cx = clamp(Math.floor(x / t.cellSize), 0, t.cols - 1);
  const cy = clamp(Math.floor(y / t.cellSize), 0, t.rows - 1);
  return TERRAIN_IDS[t.cell[cy * t.cols + cx]] ?? 'grass';
}

export function isPassable(t: Terrain, x: number, y: number): boolean {
  return terrainAt(t, x, y) !== 'water';
}

/** 采样点的移速乘区 */
export function speedFactorAt(t: Terrain, x: number, y: number): number {
  return TERRAIN_SPEED_FACTOR[terrainAt(t, x, y)];
}

/**
 * 探测锚点前方路径上的可通行宽度（米）。
 * 沿正面方向扫 depth 米，在每个截面上从中心线向两侧统计连续可通行跨度，
 * 取最窄截面。地图边界按「开阔」处理（不视为窄障），只有水域才收窄，
 * 阵型据此决定是否切纵队。
 */
export function corridorWidth(t: Terrain, x: number, y: number, angle: number, depth: number): number {
  const hx = Math.cos(angle);
  const hy = Math.sin(angle);
  const px = -hy;
  const py = hx;
  let minWidth = Infinity;
  const probeStep = 3;
  const lateralStep = 1.5;
  const maxReach = 40;

  for (let d = 0; d <= depth; d += probeStep) {
    const cx = x + hx * d;
    const cy = y + hy * d;
    // 探测中心本身出界：该截面不参与收窄判定
    if (cx < 0 || cy < 0 || cx >= t.width || cy >= t.height) continue;
    let half = 0;
    while (half < maxReach) {
      const nx = half + lateralStep;
      const lx = cx + px * nx;
      const ly = cy + py * nx;
      const rx = cx - px * nx;
      const ry = cy - py * nx;
      // 出界即视为开阔、停止扩展，但不因出界而收窄
      const lBlocked =
        lx >= 0 && ly >= 0 && lx < t.width && ly < t.height && !isPassable(t, lx, ly);
      const rBlocked =
        rx >= 0 && ry >= 0 && rx < t.width && ry < t.height && !isPassable(t, rx, ry);
      if (lBlocked || rBlocked) break;
      half = nx;
    }
    minWidth = Math.min(minWidth, half * 2);
  }
  return minWidth === Infinity ? maxReach * 2 : minWidth;
}
