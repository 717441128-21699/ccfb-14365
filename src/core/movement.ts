/**
 * 行军系统：
 *  1. 锚点沿航点推进，转弯时限角速度并按转向程度压低锚点速度；
 *     单体追踪 slot 时按到转向轴的横向距离给外侧单位速度加成（外快内慢）。
 *  2. 窄桥/走廊探测：可通行宽度不足时自动切 2 列纵队，通过且空间恢复后滞回展开。
 *  3. 每个单位用带加速度的转向追踪自己 slot 的世界坐标，叠加空间哈希分离力防挤压。
 *  4. 地形速度乘区按单位脚下采样，混编速度由编队 maxSpeed 统一封顶。
 */
import type { FormationRuntime, World } from './runtime';
import type { ClassRatio, Unit, UnitClass } from './types';
import { angleDelta, clamp, dist, headingOf, localToWorld, sub } from './math';
import { corridorWidth, speedFactorAt, terrainAt } from './terrain';
import { buildLayout } from './formation';
import type { Layout } from './formation';
import { rebuildOccupants } from './runtime';

/** 均匀空间哈希：每帧重建，供分离力与接敌检索共用 */
export class SpatialHash {
  private cell: number;
  private buckets: number[][] = [];
  private cols: number;
  private rows: number;

  constructor(worldWidth: number, worldHeight: number, cell = 4) {
    this.cell = cell;
    this.cols = Math.ceil(worldWidth / cell) + 1;
    this.rows = Math.ceil(worldHeight / cell) + 1;
    this.buckets = new Array(this.cols * this.rows);
    for (let i = 0; i < this.buckets.length; i++) this.buckets[i] = [];
  }

  clear(): void {
    for (const b of this.buckets) b.length = 0;
  }

  private key(x: number, y: number): number {
    const cx = clamp(Math.floor(x / this.cell), 0, this.cols - 1);
    const cy = clamp(Math.floor(y / this.cell), 0, this.rows - 1);
    return cy * this.cols + cx;
  }

  insert(unit: Unit): void {
    this.buckets[this.key(unit.pos.x, unit.pos.y)].push(unit.id);
  }

  /** 检索半径内单位 id（含自身，调用方过滤） */
  query(x: number, y: number, radius: number, out: number[]): number[] {
    out.length = 0;
    const minCx = clamp(Math.floor((x - radius) / this.cell), 0, this.cols - 1);
    const maxCx = clamp(Math.floor((x + radius) / this.cell), 0, this.cols - 1);
    const minCy = clamp(Math.floor((y - radius) / this.cell), 0, this.rows - 1);
    const maxCy = clamp(Math.floor((y + radius) / this.cell), 0, this.rows - 1);
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const bucket = this.buckets[cy * this.cols + cx];
        for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
      }
    }
    return out;
  }
}

const REFORM_HYSTERESIS = 1.6; // 秒，展开滞回，避免桥口来回切阵型
const ARRIVE_RADIUS = 2.2;
const ANGULAR_LIMIT = 1.1; // 弧度/秒，锚点转弯角速度上限

/**
 * 探测行军方向前方 depth 米、给定半宽的走廊内是否存在水域。
 * 不只打一条中心线，而是横向扫一个截面，斜向切角掠过河岸时也能命中水面格。
 */
function probeWaterAhead(world: World, f: FormationRuntime, depth: number): boolean {
  let hx = Math.cos(f.angle);
  let hy = Math.sin(f.angle);
  const wp = f.waypoints[f.wpIndex];
  if (wp) {
    const dx = wp.x - f.anchor.x;
    const dy = wp.y - f.anchor.y;
    const l = Math.hypot(dx, dy);
    if (l > 1e-6) {
      hx = dx / l;
      hy = dy / l;
    }
  }
  // 横向垂直方向
  const px = -hy;
  const py = hx;
  const halfWidth = 4; // 走廊半宽，覆盖一个桥身量级
  for (let d = 1; d <= depth; d += 2) {
    const cx = f.anchor.x + hx * d;
    const cy = f.anchor.y + hy * d;
    for (let w = -halfWidth; w <= halfWidth; w += 2) {
      const x = cx + px * w;
      const y = cy + py * w;
      if (x < 0 || y < 0 || x >= world.terrain.width || y >= world.terrain.height) continue;
      if (terrainAt(world.terrain, x, y) === 'water') return true;
    }
  }
  return false;
}

/** 窄桥/纵队状态机：独立于锚点推进，接敌时也必须能完成过桥后的展开 */
function updateChokeState(f: FormationRuntime, world: World, dt: number): void {
  const probeAngle = (() => {
    const wp = f.waypoints[f.wpIndex];
    return wp ? Math.atan2(wp.y - f.anchor.y, wp.x - f.anchor.x) : f.angle;
  })();
  const chokeProbe = 16;
  const width = corridorWidth(world.terrain, f.anchor.x, f.anchor.y, probeAngle, chokeProbe);
  f.chokeWidth = width;
  const waterAhead = probeWaterAhead(world, f, chokeProbe);
  const needColumn = waterAhead && width < f.layout.width * 0.9 && width < 12;
  // 出口判据看锚点脚下：踩上桥面或对岸陆地（非水面）即说明已进入/通过狭窄段。
  // 不能用「走廊无水面」——桥两侧始终是水，那样纵队永远无法结束。
  const ground = terrainAt(world.terrain, f.anchor.x, f.anchor.y);
  const crossedWater = ground !== 'water';

  // 展开冷却：恢复 normal 后 2.5s 内禁止再次成列，避免桥口 normal/column 连跳抖动
  if (f.chokeMode === 'normal') f.columnCooldown = Math.max(0, f.columnCooldown - dt);

  // 接敌后冻结阵型切换：近战接触线上反复成列/展开只会造成抖动，
  // 若正处于纵队则允许完成一次展开，之后不再改变
  if (f.engaged && f.chokeMode !== 'column' && f.chokeMode !== 'reforming') return;

  switch (f.chokeMode) {
    case 'normal':
      if (needColumn && f.columnCooldown === 0) f.chokeMode = 'approaching';
      break;
    case 'approaching':
      switchToColumn(f);
      f.chokeMode = 'column';
      f.stateTimer = 0;
      break;
    case 'column':
      // 锚点已踏上非水面（桥面/对岸）且持续滞回期，即展开恢复主战型
      if (crossedWater && f.stateTimer > REFORM_HYSTERESIS) {
        f.chokeMode = 'reforming';
        f.stateTimer = 0;
      }
      break;
    case 'reforming':
      switchToHome(f, world);
      f.chokeMode = 'normal';
      f.stateTimer = 0;
      f.columnCooldown = 2.5;
      f.reformClock = 2.2;
      f.reformConvergedFrames = 0;
      break;
  }
}

/** 锚点推进 + 窄桥状态机 */
function updateAnchor(f: FormationRuntime, world: World, dt: number): void {
  f.stateTimer += dt;
  // 状态机无条件更新：接敌早退也不影响过桥后的阵型展开
  updateChokeState(f, world, dt);

  // 接敌后锚点不再推进，阵型在接触线上原地保持
  if (f.engaged) {
    f.speed = Math.max(0, f.speed - dt * f.maxSpeed * 4);
    return;
  }

  // 航点推进
  let target: { x: number; y: number } | null = null;
  while (f.wpIndex < f.waypoints.length) {
    const wp = f.waypoints[f.wpIndex];
    if (dist(f.anchor, wp) <= ARRIVE_RADIUS) {
      f.wpIndex++;
      continue;
    }
    target = wp;
    break;
  }
  if (!target) {
    f.speed = Math.max(0, f.speed - dt * f.maxSpeed * 2);
    return;
  }

  const toTarget = sub(target, f.anchor);
  const desiredAngle = Math.atan2(toTarget.y, toTarget.x);
  const dAngle = angleDelta(f.angle, desiredAngle);
  const turn = clamp(dAngle, -ANGULAR_LIMIT * dt, ANGULAR_LIMIT * dt);
  f.angle += turn;

  // 转弯越大锚点越慢，给外侧 slot 留加速余量
  const turnFactor = 1 - Math.min(0.55, Math.abs(dAngle) * 0.35);
  const terrainFactor = speedFactorAt(world.terrain, f.anchor.x, f.anchor.y);
  const targetSpeed = f.maxSpeed * turnFactor * terrainFactor;
  const accel = 3.2;
  if (f.speed < targetSpeed) f.speed = Math.min(targetSpeed, f.speed + accel * dt);
  else f.speed = Math.max(targetSpeed, f.speed - accel * 1.6 * dt);

  const heading = headingOf(f.angle);
  f.anchor.x += heading.x * f.speed * dt;
  f.anchor.y += heading.y * f.speed * dt;
}

/**
 * 切纵队：按当前前到后、中到外的 slot 顺序重绑到纵队。
 * 纵队头排锚定锚点、向阵型后方延伸，因此锚点不动；只改 slotIndex，
 * 单位位置由转向系统平滑牵引，配合 reformClock 提速窗口，杜绝瞬移。
 */
function switchToColumn(f: FormationRuntime): void {
  const alive = f.units.filter((u) => u.alive);
  alive.sort(
    (a, b) =>
      f.layout.slotRow[a.slotIndex] - f.layout.slotRow[b.slotIndex] ||
      f.layout.slotCol[a.slotIndex] - f.layout.slotCol[b.slotIndex]
  );
  f.layout = f.columnLayout;
  alive.forEach((u, i) => {
    if (i < f.layout.slots.length) u.slotIndex = i;
  });
  f.reformClock = 1.6; // 成列过渡窗口
  rebuildOccupants(f);
}

/** 恢复主战型：用当前存活兵种比例重新混编排位，单位软重排过去 */
function switchToHome(f: FormationRuntime, world: World): void {
  const alive = f.units.filter((u) => u.alive);
  f.layout = buildLayout(
    f.homeType,
    alive,
    world.classes as Map<Unit['cls'], UnitClass>,
    liveCompositionOf(f)
  );
  rebuildOccupants(f);
}

/** 统计编队当前存活兵种比例 */
function liveCompositionOf(f: FormationRuntime): ClassRatio[] {
  const counts = new Map<Unit['cls'], number>();
  for (const u of f.units) {
    if (u.alive) counts.set(u.cls, (counts.get(u.cls) ?? 0) + 1);
  }
  return [...counts.entries()].map(([cls, count]) => ({ cls, count }));
}

/**
 * 伤亡紧凑重排：阵亡累积导致 slot 出现跨列空洞时，用存活单位按当前阵型重建。
 * composition 按各兵种真实存活数统计，使混排规则（枪在前、弓弩在后）减员后仍成立。
 * 纵队态只在过桥，重建会破坏头排锚定几何，因此跳过——同列补位已足够维持桥面秩序，
 * 待恢复主战型（switchToHome）时再按存活比例一次性重排。
 */
function rebuildCompact(f: FormationRuntime, world: World): void {
  if (f.chokeMode === 'column' || f.chokeMode === 'approaching') return;
  const alive = f.units.filter((u) => u.alive);
  if (alive.length === 0) return;
  f.layout = buildLayout(
    f.homeType,
    alive,
    world.classes as Map<Unit['cls'], UnitClass>,
    liveCompositionOf(f)
  );
  rebuildOccupants(f);
  f.reformClock = 1.4;
  f.reformConvergedFrames = 0;
}

/** 单体 slot 追踪 + 分离力 */
function steerUnit(
  f: FormationRuntime,
  u: Unit,
  world: World,
  hash: SpatialHash,
  dt: number,
  turnAmount: number,
  scratch: number[]
): void {
  const slotIdx = Math.min(u.slotIndex, f.layout.slots.length - 1);
  const slot = f.layout.slots[slotIdx];
  const goal = localToWorld(f.anchor, f.angle, slot.local);

  const cls = world.classes.get(u.cls)!;
  const toGoal = sub(goal, u.pos);
  const goalDist = Math.hypot(toGoal.x, toGoal.y);

  // 分离力：只在真实物理重叠（间距 < 0.72 倍占位，即明显穿插）时介入。
  // slot 本身按完整 spacing 排布，正常阵型不会触发，因此归位力始终主导，
  // 仅在骑兵冲锋挤压、过桥堆叠等真穿插时把单位轻轻推开。
  let sepX = 0;
  let sepY = 0;
  const minD = cls.spacing * 0.72;
  hash.query(u.pos.x, u.pos.y, cls.spacing, scratch);
  for (let i = 0; i < scratch.length; i++) {
    const other = world.units[scratch[i]];
    if (other.id === u.id || !other.alive || other.team !== u.team) continue;
    const dx = u.pos.x - other.pos.x;
    const dy = u.pos.y - other.pos.y;
    const d2 = dx * dx + dy * dy;
    const otherMin = (minD + world.classes.get(other.cls)!.spacing * 0.72) * 0.5;
    if (d2 < otherMin * otherMin && d2 > 1e-8) {
      const d = Math.sqrt(d2);
      // 三次平滑权重：刚触界几乎无力，越深推开越强
      const overlap = (otherMin - d) / otherMin;
      const push = overlap * overlap * overlap;
      sepX += (dx / d) * push;
      sepY += (dy / d) * push;
    }
  }
  // 已在 slot 附近时进一步抑制分离，让归位优先
  const slotGate = clamp(goalDist / (cls.spacing * 2), 0.2, 1);

  const terrainFactor = speedFactorAt(world.terrain, u.pos.x, u.pos.y);
  const unitMax = cls.speed * terrainFactor;

  // 转弯差速：横向越靠外，速度上限越高（外快内慢），直行时回落到正常上限
  const lateralRatio = f.layout.maxLateral > 0
    ? Math.abs(slot.local.y) / f.layout.maxLateral
    : 0;
  const differential = 1 + lateralRatio * turnAmount * 0.45;
  // 重排窗口：从深纵队收回主战型时给大额超速余量
  const reformBoost = f.reformClock > 0 ? clamp(1.6 + goalDist / 6, 1.6, 2.8) : 1;
  // 连续误差补偿：任何落后 slot 的单位都按误差大小获得超速余量，
  // 使其能追上持续移动的槽位；贴位时（误差→0）自动回落到正常速度
  const catchUpBoost = clamp(1 + goalDist / 4, 1, 1.8);

  // 前馈：slot 本身随锚点平移的速度，保证稳态零滞后
  const anchorHeading = headingOf(f.angle);
  const ffX = anchorHeading.x * f.speed;
  const ffY = anchorHeading.y * f.speed;

  // 位置误差比例项：把单位拉回 slot，高增益保证稳态贴合到半个身位内
  const kp = 5.0;
  let vx = ffX + toGoal.x * kp + sepX * unitMax * 1.2 * slotGate;
  let vy = ffY + toGoal.y * kp + sepY * unitMax * 1.2 * slotGate;
  const vl = Math.hypot(vx, vy);
  const cap = unitMax * 1.4 * differential * reformBoost * catchUpBoost;
  if (vl > cap) {
    vx = (vx / vl) * cap;
    vy = (vy / vl) * cap;
  }

  // 加速度限幅（平滑，杜绝瞬间横移），响应足够快不引入稳态滞后
  const resp = 10;
  const k = clamp(resp * dt, 0, 1);
  u.velX += (vx - u.velX) * k;
  u.velY += (vy - u.velY) * k;
  u.pos.x += u.velX * dt;
  u.pos.y += u.velY * dt;

  // 朝向：行军跟速度方向，静止跟阵型正面
  const speedNow = Math.hypot(u.velX, u.velY);
  if (speedNow > 0.4) {
    const desired = Math.atan2(u.velY, u.velX);
    u.angle += angleDelta(u.angle, desired) * clamp(8 * dt, 0, 1);
  } else {
    u.angle += angleDelta(u.angle, f.angle) * clamp(5 * dt, 0, 1);
  }

  u.pos.x = clamp(u.pos.x, 0.5, world.terrain.width - 0.5);
  u.pos.y = clamp(u.pos.y, 0.5, world.terrain.height - 0.5);
}

export interface MoveStats {
  avgError: number;
  maxError: number;
}

/** 行军整帧入口 */
export function updateMovement(world: World, dt: number, hash: SpatialHash): MoveStats {
  hash.clear();
  for (const u of world.units) {
    if (u.alive) hash.insert(u);
  }

  // 记录各编队转弯强度（锚点速度方向与当前正面的偏差）
  const turnAmounts = new Map<number, number>();
  for (const f of world.formations) {
    updateAnchor(f, world, dt);
    const wp = f.waypoints[f.wpIndex];
    if (wp && !f.engaged) {
      const want = Math.atan2(wp.y - f.anchor.y, wp.x - f.anchor.x);
      turnAmounts.set(f.spec.id, clamp(Math.abs(angleDelta(f.angle, want)) / 1.2, 0, 1));
    } else {
      turnAmounts.set(f.spec.id, 0);
    }
  }

  const scratch: number[] = [];
  let errSum = 0;
  let errMax = 0;
  let errN = 0;
  for (const f of world.formations) {
    const turnAmount = turnAmounts.get(f.spec.id) ?? 0;

    // 伤亡紧凑重排：冷却到期且 slot 空洞占比超过 12% 时重建布局
    f.rebuildCooldown = Math.max(0, f.rebuildCooldown - dt);
    if (f.rebuildCooldown === 0) {
      const aliveN = f.units.reduce((s, u) => s + (u.alive ? 1 : 0), 0);
      const holes = f.layout.slots.length - aliveN;
      if (aliveN > 0 && holes / f.layout.slots.length > 0.12) {
        rebuildCompact(f, world);
        f.rebuildCooldown = 2.0;
      }
    }

    // 先推进单位，再按本阵真实误差决定重排窗口是否延续
    let fMax = 0;
    for (const u of f.units) {
      if (!u.alive) continue;
      steerUnit(f, u, world, hash, dt, turnAmount, scratch);
      const slot = f.layout.slots[Math.min(u.slotIndex, f.layout.slots.length - 1)];
      const goal = localToWorld(f.anchor, f.angle, slot.local);
      fMax = Math.max(fMax, dist(u.pos, goal));
    }

    if (f.chokeMode === 'normal' && !f.engaged) {
      if (f.reformClock > 0) {
        // 窗口固定倒计时；连续 15 帧（0.5s）误差收敛到一个身位内则提前关窗。
        // 窗口只由真实阵型切换（成列/展开）和伤亡紧凑重排开启，
        // 不在普通行军波动时自动开窗，避免反复重排 slot 引发抖动。
        f.reformClock = Math.max(0, f.reformClock - dt);
        if (fMax <= 1.2) {
          f.reformConvergedFrames++;
          if (f.reformConvergedFrames >= 15) {
            f.reformClock = 0;
            f.reformConvergedFrames = 0;
          }
        } else {
          f.reformConvergedFrames = 0;
          // 窗口将尽仍未收敛：续一段，保证大幅重排有足够时间归位
          if (f.reformClock === 0 && fMax > 3) f.reformClock = 1.5;
        }
      }
      if (f.reformClock === 0) {
        errSum += fMax;
        errMax = Math.max(errMax, fMax);
        errN++;
      }
    } else if (f.reformClock > 0) {
      f.reformClock = Math.max(0, f.reformClock - dt);
      f.reformConvergedFrames = 0;
    }
    f.avgSlotError = fMax;
    f.maxSlotError = fMax;
  }
  return { avgError: errN ? errSum / errN : 0, maxError: errMax };
}
