/**
 * 阵型布局：把一份混编比例展开成带局部坐标的槽位，并负责阵亡后的同列补位。
 * 局部坐标系：+x 为阵型正面方向，+y 为左翼。槽位间距按兵种占位自适应。
 */
import type { ClassRatio, FormationType, Slot, Unit, UnitClass, UnitClassId } from './types';

export interface LayoutRow {
  /** 该行每个 slot 的序号（按局部 y 排序），长度 = 该行列数 */
  slotIds: number[];
  /** 该行 x 坐标（局部） */
  x: number;
}

export interface Layout {
  slots: Slot[];
  rows: LayoutRow[];
  /** slotId -> 行号 */
  slotRow: number[];
  /** slotId -> 列号 */
  slotCol: number[];
  /** 阵型最大宽度（局部 y 方向，米） */
  width: number;
  /** 阵型纵深（局部 x 方向，米） */
  depth: number;
  /** 离锚点最远的横向距离，用于转弯限速 */
  maxLateral: number;
  /** 统一占位间距 */
  spacing: number;
}

/** 有效占位间距：取该阵型中各兵种间距的加权平均，量化到 0.1m */
function effectiveSpacing(
  composition: ClassRatio[],
  classes: Map<UnitClassId, UnitClass>
): number {
  let total = 0;
  let n = 0;
  for (const c of composition) {
    const cls = classes.get(c.cls)!;
    total += cls.spacing * c.count;
    n += c.count;
  }
  if (n === 0) return 1.6;
  return Math.round((total / n) * 10) / 10;
}

const groupOf = (id: UnitClassId): number => {
  if (id === 'pike' || id === 'spear') return 0; // 最长的枪贴最前
  if (id === 'sword') return 1; // 盾剑中层
  if (id === 'archer' || id === 'crossbow') return 2; // 弓弩后排
  return 3; // 骑兵/器械特殊处理
};

/** 构建槽位几何（不含兵种分配） */
function buildSlots(
  type: FormationType,
  count: number,
  spacing: number,
  columnCols = 3
): { slots: Slot[]; rows: LayoutRow[] } {
  const slots: Slot[] = [];
  const rows: LayoutRow[] = [];

  const pushGrid = (pts: { x: number; y: number }[]): void => {
    const rowMap = new Map<number, number[]>();
    for (const p of pts) {
      const id = slots.length;
      slots.push({ local: { x: p.x, y: p.y }, row: -1, col: -1 });
      if (!rowMap.has(p.x)) rowMap.set(p.x, []);
      rowMap.get(p.x)!.push(id);
    }
    const xs = [...rowMap.keys()].sort((a, b) => a - b);
    for (let r = 0; r < xs.length; r++) {
      const ids = rowMap.get(xs[r])!;
      ids.sort((a, b) => slots[a].local.y - slots[b].local.y);
      rows.push({ slotIds: ids, x: xs[r] });
      ids.forEach((id, c) => {
        slots[id].row = r;
        slots[id].col = c;
      });
    }
  };

  if (type === 'line') {
    // 横队：宽正面、浅纵深。约束最大正面宽度（半宽 ≤12m），人数多时加深排数
    const maxPerRow = 14;
    const rankDepth = Math.max(2, Math.ceil(count / maxPerRow));
    const perRow = Math.ceil(count / rankDepth);
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < count; i++) {
      const r = Math.floor(i / perRow);
      const c = i % perRow;
      pts.push({ x: r * spacing, y: (c - (perRow - 1) / 2) * spacing });
    }
    pushGrid(pts);
  } else if (type === 'column') {
    // 纵队：窄桥通过用，列数由调用方按桥宽给定（默认 3 列适配 6m 桥）
    const cols = columnCols;
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < count; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      // 头排锚定锚点（局部 x=0），后续排向阵型后方(-x)延伸，切换时锚点不动
      const x = -r * spacing;
      const y = (c - (cols - 1) / 2) * spacing;
      pts.push({ x, y });
    }
    pushGrid(pts);
  } else if (type === 'wedge') {
    // 楔形：尖端 1 人逐排 +2，排宽封顶；剩余单位在封顶排的内圈半步距补位，
    // 严格限制总宽度（半宽 ≤12m），纵深略增，避免大楔阵越过河面或地图边界
    const maxRankWidth = 9;
    const maxRows = 12;
    const pts: { x: number; y: number }[] = [];
    let placed = 0;
    // 阶段一：标准三角直到排宽封顶
    for (let r = 0; r < maxRows && placed < count; r++) {
      const width = Math.min(2 * r + 1, maxRankWidth);
      for (let c = 0; c < width && placed < count; c++) {
        pts.push({ x: r * spacing, y: (c - (width - 1) / 2) * spacing });
        placed++;
      }
    }
    // 阶段二：剩余单位在既有排的内圈（贴近中心线）半步距补位，宽度只小幅外扩
    let layer = 0;
    let guard = 0;
    while (placed < count && guard++ < count * 2) {
      const r = placed % maxRows;
      if (placed % (maxRows * 2) === 0) layer++;
      const side = placed % 2 === 0 ? -1 : 1;
      // 在内圈补位：紧贴最内侧已有单位，外扩量受 0.5 倍步距约束
      const yy = side * (0.5 + (layer - 1) * 0.5) * spacing;
      pts.push({ x: r * spacing, y: yy });
      placed++;
    }
    pushGrid(pts);
  } else if (type === 'square') {
    // 方阵城：行列接近，纵深略大
    const cols = Math.max(2, Math.round(Math.sqrt(count) * 0.8));
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < count; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      pts.push({ x: r * spacing, y: (c - (cols - 1) / 2) * spacing });
    }
    pushGrid(pts);
  } else {
    // phalanx 密集方阵：正面略宽于纵深
    const cols = Math.max(2, Math.round(Math.sqrt(count * 1.15)));
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < count; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      pts.push({ x: r * spacing, y: (c - (cols - 1) / 2) * spacing });
    }
    pushGrid(pts);
  }

  return { slots, rows };
}

function finalize(type: FormationType, slots: Slot[], rows: LayoutRow[], spacing: number): Layout {
  const slotRow: number[] = new Array(slots.length);
  const slotCol: number[] = new Array(slots.length);
  slots.forEach((s, i) => {
    slotRow[i] = s.row;
    slotCol[i] = s.col;
  });
  const maxLateral = slots.reduce((m, s) => Math.max(m, Math.abs(s.local.y)), 0);
  const width = maxLateral * 2;
  const depth = slots.reduce((m, s) => Math.max(m, s.local.x), 0);
  void type;
  return { slots, rows, slotRow, slotCol, width, depth, maxLateral, spacing };
}

/**
 * 混编兵种排位：
 *  - 通用（方阵/横队/楔形/纵队）：骑兵占两翼外缘，器械占后排中央，
 *    长矛→长枪→盾剑→弓弩 按前中后排位，同排居中向外。
 *  - 方阵城：按距中心的环层分配，骑兵占外环四角，长枪外环，盾剑中环，弓弩内环，器械核心。
 */
function assignUnits(
  type: FormationType,
  units: Unit[],
  layout: Layout
): void {
  const { slots } = layout;
  const taken = new Set<number>();
  const indexOf = new Map<Slot, number>();
  slots.forEach((s, i) => indexOf.set(s, i));
  const mark = (u: Unit, s: Slot): void => {
    const idx = indexOf.get(s)!;
    taken.add(idx);
    u.slotIndex = idx;
  };
  const isFree = (s: Slot): boolean => !taken.has(indexOf.get(s)!);

  const byClass = new Map<UnitClassId, Unit[]>();
  for (const u of units) {
    const arr = byClass.get(u.cls) ?? [];
    arr.push(u);
    byClass.set(u.cls, arr);
  }
  const drain = (id: UnitClassId): Unit[] => byClass.get(id)?.splice(0) ?? [];

  if (type === 'square') {
    // 显式环层：环号 = slot 到外缘的最小层数，0 = 最外环
    const nRows = layout.rows.length;
    const maxCols = Math.max(...layout.rows.map((r) => r.slotIds.length));
    const ringOfSlot = (s: Slot): number => {
      const fromFront = s.row;
      const fromBack = nRows - 1 - s.row;
      const fromSide = Math.min(s.col, maxCols - 1 - s.col);
      return Math.max(0, Math.min(fromFront, fromBack, fromSide));
    };
    const ringCount = Math.max(...slots.map(ringOfSlot)) + 1;
    const rings: Slot[][] = Array.from({ length: ringCount }, () => []);
    for (const s of slots) rings[ringOfSlot(s)].push(s);
    // 每环内：两翼（|y| 大）在前，便于骑兵先占外角
    rings.forEach((r) => r.sort((a, b) => Math.abs(b.local.y) - Math.abs(a.local.y) || a.row - b.row));

    // 把某兵种的单位依次放入从 outer 环开始的最外空闲环
    const assignToOuterRings = (queue: Unit[], outer: number): void => {
      for (const u of queue) {
        let placed = false;
        for (let r = outer; r < ringCount && !placed; r++) {
          const s = rings[r].find(isFree);
          if (s) {
            mark(u, s);
            placed = true;
          }
        }
      }
    };

    // 1) 骑兵占最外环（ring 0）两翼外角
    assignToOuterRings(drain('cavalry'), 0);
    // 2) 长枪/长矛/盾剑填满外环硬壳
    for (const id of ['pike', 'spear', 'sword'] as UnitClassId[]) {
      assignToOuterRings(drain(id), 0);
    }
    // 3) 剩余近战（若外环满）向中环安置
    for (const id of ['sword', 'spear', 'pike'] as UnitClassId[]) {
      assignToOuterRings(drain(id), 1);
    }
    // 4) 弓弩入内环（从倒数第二环开始）
    const innerStart = Math.max(1, ringCount - 2);
    for (const id of ['crossbow', 'archer'] as UnitClassId[]) {
      assignToOuterRings(drain(id), innerStart);
    }
    // 5) 器械核心：最内环靠中心
    const core = [...slots].sort(
      (a, b) =>
        Math.hypot(a.local.x - layout.depth / 2, a.local.y) -
        Math.hypot(b.local.x - layout.depth / 2, b.local.y)
    );
    for (const id of ['ram', 'catapult'] as UnitClassId[]) {
      for (const u of drain(id)) {
        const s = core.find(isFree);
        if (s) mark(u, s);
      }
    }
    // 6) 兜底：任何剩余单位逐个占空闲 slot，保证一人一 slot、无重复无遗漏
    for (const list of byClass.values()) {
      for (const u of list) {
        const s = slots.find(isFree);
        if (s) mark(u, s);
      }
    }
    return;
  }

  // 通用排位
  const byRows = [...slots].sort((a, b) => a.row - b.row || a.col - b.col);
  const maxRow = layout.rows.length - 1;

  // 1) 骑兵：两翼最外侧，从前排往后
  for (const u of drain('cavalry')) {
    let chosen: Slot | undefined;
    for (let r = 0; r <= maxRow && !chosen; r++) {
      chosen = byRows
        .filter((s) => s.row === r && isFree(s))
        .sort((a, b) => Math.abs(b.local.y) - Math.abs(a.local.y))[0];
    }
    if (chosen) mark(u, chosen);
  }

  // 2) 器械：最后一排中央
  const backRow = byRows.filter((s) => s.row === maxRow);
  for (const id of ['ram', 'catapult'] as UnitClassId[]) {
    for (const u of drain(id)) {
      const chosen = backRow.filter(isFree).sort(
        (a, b) => Math.abs(a.local.y) - Math.abs(b.local.y)
      )[0];
      if (chosen) mark(u, chosen);
    }
  }

  // 3) 步兵/弓弩：按前中后组序，同排居中向外
  const infantry: Unit[] = [];
  for (const id of ['pike', 'spear', 'sword', 'crossbow', 'archer'] as UnitClassId[]) {
    infantry.push(...drain(id));
  }
  infantry.sort((a, b) => groupOf(a.cls) - groupOf(b.cls));
  const freePool = (): Slot[] =>
    byRows.filter(isFree).sort(
      (a, b) => a.row - b.row || Math.abs(a.local.y) - Math.abs(b.local.y)
    );
  let pool = freePool();
  for (const u of infantry) {
    if (pool.length === 0) pool = freePool();
    const s = pool.shift();
    if (s) mark(u, s);
  }

  // 兜底（理论上不会走到）
  for (const list of byClass.values()) {
    for (const u of list) {
      const s = slots.find(isFree);
      if (s) mark(u, s);
    }
  }
}

/** 生成完整布局并把单位绑到槽位上 */
export function buildLayout(
  type: FormationType,
  units: Unit[],
  classes: Map<UnitClassId, UnitClass>,
  composition: ClassRatio[]
): Layout {
  const spacing = effectiveSpacing(composition, classes);
  const geo = buildSlots(type, units.length, spacing);
  const layout = finalize(type, geo.slots, geo.rows, spacing);
  assignUnits(type, units, layout);
  return layout;
}

/** 窄桥通过用的纵队布局（单位保持原 slotIndex 绑定，由调用方重排） */
export function buildColumnLayout(count: number, spacing: number, cols = 3): Layout {
  const geo = buildSlots('column', count, spacing, cols);
  return finalize('column', geo.slots, geo.rows, spacing);
}

/**
 * 阵亡补位：沿阵亡单位所在的「同列」（局部 y 相同的槽位）向后找最近的存活
 * 单位依次前移。用局部坐标匹配列，而不是 ragged 网格里易错位的数组下标，
 * 保证非满排/楔形等列数不齐的阵型也不会把后排弓弩错位顶到侧翼前排。
 * 单向、确定性，避免前排来回抖动。
 * slotOccupants: slotId -> 当前占用该 slot 的存活单位（由 World 维护）
 */
export function compactAfterDeath(
  dead: Unit,
  layout: Layout,
  slotOccupants: (Unit | null)[]
): number[] {
  const startSlot = dead.slotIndex;
  const startRow = layout.slotRow[startSlot];
  const targetY = layout.slots[startSlot].local.y;
  const yTol = layout.spacing * 0.25;
  const moved: number[] = [];

  let prevSlot = startSlot;
  for (let r = startRow + 1; r < layout.rows.length; r++) {
    // 在这一排里找局部 y 与阵亡列对齐的槽位
    let nextSlotId = -1;
    for (const sid of layout.rows[r].slotIds) {
      if (Math.abs(layout.slots[sid].local.y - targetY) <= yTol) {
        nextSlotId = sid;
        break;
      }
    }
    if (nextSlotId < 0) continue; // 该排无同列槽位，跳过但继续向后找
    const occupant = slotOccupants[nextSlotId];
    if (!occupant) {
      prevSlot = nextSlotId; // 空洞继续向下传递
      continue;
    }
    slotOccupants[prevSlot] = occupant;
    slotOccupants[nextSlotId] = null;
    occupant.slotIndex = prevSlot;
    moved.push(occupant.id);
    prevSlot = nextSlotId;
  }
  slotOccupants[startSlot] = slotOccupants[startSlot] ?? null;
  return moved;
}
