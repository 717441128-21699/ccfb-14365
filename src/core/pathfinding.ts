/** 地形方格上的 A* 寻路。网格小（65×45），每次规划在微秒级。 */
import type { Terrain } from './types';
import { TERRAIN_COST, terrainAt } from './terrain';

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, key: number): void {
    this.ids.push(id);
    this.keys.push(key);
    let i = this.ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.ids[0];
    const lastId = this.ids.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.ids.length > 0) {
      this.ids[0] = lastId;
      this.keys[0] = lastKey;
      let i = 0;
      const n = this.ids.length;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < n && this.keys[l] < this.keys[smallest]) smallest = l;
        if (r < n && this.keys[r] < this.keys[smallest]) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const ti = this.ids[a];
    this.ids[a] = this.ids[b];
    this.ids[b] = ti;
    const tk = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = tk;
  }
}

export interface GridPath {
  /** 世界坐标路径点（含起点、终点） */
  points: { x: number; y: number }[];
}

/**
 * A* 规划。formationHalfWidth 用于在水域边缘做软膨胀：
 * 桥只有 6m 宽，大阵型寻路时仍会被引到桥上，纵队切换由行军状态机负责。
 */
export function findPath(
  terrain: Terrain,
  start: { x: number; y: number },
  goal: { x: number; y: number }
): GridPath | null {
  const { cols, rows, cellSize } = terrain;
  const toCell = (p: { x: number; y: number }): number => {
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(p.x / cellSize)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor(p.y / cellSize)));
    return cy * cols + cx;
  };
  const startId = toCell(start);
  const goalId = toCell(goal);

  const gScore = new Float64Array(cols * rows).fill(Infinity);
  const came = new Int32Array(cols * rows).fill(-1);
  const closed = new Uint8Array(cols * rows);
  const heap = new MinHeap();

  const heuristic = (id: number): number => {
    const x1 = id % cols;
    const y1 = (id / cols) | 0;
    const x2 = goalId % cols;
    const y2 = (goalId / cols) | 0;
    // 八方向 octile 距离
    const dx = Math.abs(x1 - x2);
    const dy = Math.abs(y1 - y2);
    return (dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy)) * cellSize;
  };

  gScore[startId] = 0;
  heap.push(startId, heuristic(startId));

  const neighbors = new Int32Array(8);
  while (heap.size > 0) {
    const current = heap.pop();
    if (current === goalId) break;
    if (closed[current]) continue;
    closed[current] = 1;

    const cx = current % cols;
    const cy = (current / cols) | 0;
    let nCount = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        neighbors[nCount++] = ny * cols + nx;
      }
    }

    for (let k = 0; k < nCount; k++) {
      const next = neighbors[k];
      if (closed[next]) continue;
      const nx = next % cols;
      const ny = (next / cols) | 0;
      const wx = (nx + 0.5) * cellSize;
      const wy = (ny + 0.5) * cellSize;
      const tType = terrainAt(terrain, wx, wy);
      const stepCost = TERRAIN_COST[tType];
      if (!isFinite(stepCost)) continue;
      const diagonal = next - current !== cols && next - current !== -cols &&
        Math.abs(next - current) !== 1;
      const moveCost = (diagonal ? Math.SQRT2 * cellSize : cellSize) * stepCost;
      const tentative = gScore[current] + moveCost;
      if (tentative < gScore[next]) {
        gScore[next] = tentative;
        came[next] = current;
        heap.push(next, tentative + heuristic(next));
      }
    }
  }

  if (!isFinite(gScore[goalId])) return null;

  // 回溯并做共线抽稀，减少行军状态机的航点数量
  const cellPath: number[] = [];
  let cur = goalId;
  while (cur !== -1) {
    cellPath.push(cur);
    if (cur === startId) break;
    cur = came[cur];
  }
  cellPath.reverse();

  const raw = cellPath.map((id) => ({
    x: (id % cols + 0.5) * cellSize,
    y: (((id / cols) | 0) + 0.5) * cellSize
  }));

  // 弦切（string-pulling）：只要两点直连线段全程可通行，就跳过中间锯齿航点，
  // 把 2m 网格上的折线拉直成少量平滑航点，锚点不再频繁微调朝向。
  const points = [raw[0]];
  let anchorIdx = 0;
  while (anchorIdx < raw.length - 1) {
    let farthest = anchorIdx + 1;
    for (let j = raw.length - 1; j > anchorIdx + 1; j--) {
      if (segmentWalkable(terrain, raw[anchorIdx], raw[j], cellSize)) {
        farthest = j;
        break;
      }
    }
    points.push(raw[farthest]);
    anchorIdx = farthest;
  }
  return { points };
}

/** 沿线段按 cellSize 步长采样，任一点不可通行即视为不可直连 */
function segmentWalkable(
  terrain: Terrain,
  a: { x: number; y: number },
  b: { x: number; y: number },
  cellSize: number
): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(len / (cellSize * 0.5)));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = a.x + dx * t;
    const y = a.y + dy * t;
    if (terrainAt(terrain, x, y) === 'water') return false;
  }
  return true;
}
