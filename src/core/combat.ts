/**
 * 接敌系统：
 *  - 前排单位在交战距离内锁定最近敌人，停下来厮杀；后排沿同列 slot 补位（单向、无抖动）。
 *  - 远程单位在射程内周期投放投射物，近战单位贴脸才出手。
 *  - 编队按剩余兵力做士气判定，低于阈值整体溃退。
 *  - 所有近邻检索复用空间哈希，1000 单位每帧保持线性复杂度，热路径零闭包分配。
 */
import type { FormationRuntime, World } from './runtime';
import type { Projectile, Unit } from './types';
import { clamp, dist } from './math';
import { compactAfterDeath } from './formation';
import type { SpatialHash } from './movement';
import { terrainAt } from './terrain';

const ROUT_RATIO = 0.32; // 兵力低于初始 32% 时溃退
const ENGAGE_BAND = 6; // 编队进入接敌的探测带宽（米）

/** 两点连线是否被水面阻断（隔河不能近战/直射）。网格整数步进，无浮点分配。 */
function blockedByWater(world: World, ax: number, ay: number, bx: number, by: number): boolean {
  const t = world.terrain;
  let cx = Math.floor(ax / t.cellSize);
  let cy = Math.floor(ay / t.cellSize);
  const ex = Math.floor(bx / t.cellSize);
  const ey = Math.floor(by / t.cellSize);
  const sx = cx < ex ? 1 : cx > ex ? -1 : 0;
  const sy = cy < ey ? 1 : cy > ey ? -1 : 0;
  // DDA 网格遍历：跨越的格子数有界于曼哈顿距离，通常 2~6 格
  let guard = 0;
  while (guard++ < 64) {
    if (cx === ex && cy === ey) return false;
    cx += sx;
    cy += sy;
    if (cx < 0 || cy < 0 || cx >= t.cols || cy >= t.rows) return false;
    if (t.cell[cy * t.cols + cx] === 4) return true; // water 的编码为 4
  }
  return false;
}

function findNearestEnemy(
  world: World,
  u: Unit,
  radius: number,
  hash: SpatialHash,
  scratch: number[]
): Unit | null {
  hash.query(u.pos.x, u.pos.y, radius, scratch);
  const riverY = world.terrain.riverY;
  const r2 = radius * radius;
  let best: Unit | null = null;
  let bestD2 = Infinity;
  const ux = u.pos.x;
  const uy = u.pos.y;
  for (let i = 0; i < scratch.length; i++) {
    const other = world.units[scratch[i]];
    if (!other.alive || other.team === u.team) continue;
    const dx = ux - other.pos.x;
    const dy = uy - other.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 >= bestD2 || d2 > r2) continue;
    // 廉价预过滤：只有分居河流两岸（y 夹住 riverY）才可能被水面阻断
    if ((uy - riverY) * (other.pos.y - riverY) < 0 &&
      blockedByWater(world, ux, uy, other.pos.x, other.pos.y)) continue;
    bestD2 = d2;
    best = other;
  }
  return best;
}

function killUnit(world: World, f: FormationRuntime, dead: Unit): void {
  dead.alive = false;
  dead.hp = 0;
  f.occupants[dead.slotIndex] = null;
  compactAfterDeath(dead, f.layout, f.occupants);
}

/** 投射物推进与命中（swap-pop 压缩，零额外数组分配） */
export function updateProjectiles(world: World, dt: number): void {
  const list = world.projectiles;
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    const target = world.units[p.targetId];
    if (!target || !target.alive) {
      list[i] = list[list.length - 1];
      list.pop();
      continue;
    }
    const dx = target.pos.x - p.pos.x;
    const dy = target.pos.y - p.pos.y;
    const d = Math.hypot(dx, dy);
    const step = p.speed * dt;
    if (d <= step + 0.6) {
      target.hp -= p.damage;
      target.hitFlash = 0.18;
      list[i] = list[list.length - 1];
      list.pop();
      if (target.hp <= 0) {
        const ef = world.formationByUnit[target.id];
        if (ef) killUnit(world, ef, target);
      }
    } else {
      p.pos.x += (dx / d) * step;
      p.pos.y += (dy / d) * step;
    }
  }
}

/** 战斗整帧入口（在行军之后执行） */
export function updateCombat(world: World, dt: number, hash: SpatialHash): void {
  const scratch: number[] = [];
  world.searchTick++;

  for (const f of world.formations) {
    // 士气判定：用 slot 占用数代替每帧 reduce
    let aliveCount = 0;
    for (const o of f.occupants) if (o) aliveCount++;
    const routed = aliveCount / f.initialStrength < ROUT_RATIO;

    let formationContact = false;

    for (let ui = 0; ui < f.units.length; ui++) {
      const u = f.units[ui];
      if (!u.alive) continue;
      u.hitFlash = Math.max(0, u.hitFlash - dt);
      u.attackTimer -= dt;
      const cls = world.classes.get(u.cls)!;

      if (routed) u.state = 'rout';

      if (u.state === 'rout') {
        // 溃退：背离最近敌人加速脱离
        const enemy = findNearestEnemy(world, u, 14, hash, scratch);
        let dx = 0;
        let dy = 0;
        if (enemy) {
          dx = u.pos.x - enemy.pos.x;
          dy = u.pos.y - enemy.pos.y;
        } else {
          dx = -Math.cos(f.angle);
          dy = -Math.sin(f.angle);
        }
        const l = Math.hypot(dx, dy) || 1;
        u.velX = (dx / l) * cls.speed * 1.15;
        u.velY = (dy / l) * cls.speed * 1.15;
        u.pos.x += u.velX * dt;
        u.pos.y += u.velY * dt;
        u.angle = Math.atan2(u.velY, u.velX);
        continue;
      }

      // 检索半径：近战用交战带，远程用射程
      const searchR = cls.range > 0 ? cls.range : Math.max(cls.engageDist + ENGAGE_BAND, 8);

      // 目标复用：当前目标仍存活、在射程内且未被水面阻断时直接沿用，
      // 避免每个远程单位每帧都对几百个邻居做全量空间检索
      let enemy: Unit | null = null;
      const cached = u.targetId >= 0 ? world.units[u.targetId] : null;
      if (cached && cached.alive && cached.team !== u.team) {
        const cdx = u.pos.x - cached.pos.x;
        const cdy = u.pos.y - cached.pos.y;
        const inRange = cdx * cdx + cdy * cdy <= searchR * searchR;
        const cacheBlocked =
          (u.pos.y - world.terrain.riverY) * (cached.pos.y - world.terrain.riverY) < 0 &&
          blockedByWater(world, u.pos.x, u.pos.y, cached.pos.x, cached.pos.y);
        if (inRange && !cacheBlocked) enemy = cached;
      }
      // 远程单位（大搜索半径）无目标时节流：按 id 奇偶隔帧索敌，
      // 把每帧的大范围空间查询量直接减半；近战半径小、不受限
      const isRanged = cls.range > 0;
      const throttleOk = !isRanged || ((u.id + world.searchTick) % 2 === 0);
      if (!enemy && throttleOk) enemy = findNearestEnemy(world, u, searchR, hash, scratch);

      if (!enemy) {
        if (u.state === 'melee' || u.state === 'firing') u.state = 'march';
        u.targetId = -1;
        continue;
      }
      u.targetId = enemy.id;

      const d = dist(u.pos, enemy.pos);

      if (cls.range > 0 && d > cls.engageDist + 1) {
        // 远程：行进间减速射击（后排弓手/投石机），不令整个编队锚点停推
        u.state = 'firing';
        u.targetId = enemy.id;
        const brake = 1 - clamp(2.2 * dt, 0, 1);
        u.velX *= brake;
        u.velY *= brake;
        u.angle = Math.atan2(enemy.pos.y - u.pos.y, enemy.pos.x - u.pos.x);
        if (u.attackTimer <= 0) {
          const proj: Projectile = {
            pos: { x: u.pos.x, y: u.pos.y },
            targetId: enemy.id,
            speed: cls.kind === 'siege' ? 26 : 34,
            damage: cls.rangedDamage,
            team: u.team,
            alive: true
          };
          world.projectiles.push(proj);
          u.attackTimer = cls.rangedCooldown;
        }
        // 仅当敌人逼近近战威胁带才冻结锚点；远距离对射保持行军
        if (d <= 16) formationContact = true;
        continue;
      }

      // 近战
      if (d <= cls.engageDist + 0.4) {
        u.state = 'melee';
        u.targetId = enemy.id;
        formationContact = true;
        // 前排停下厮杀：速度快速归零
        const brake = 1 - clamp(8 * dt, 0, 1);
        u.velX *= brake;
        u.velY *= brake;
        u.angle = Math.atan2(enemy.pos.y - u.pos.y, enemy.pos.x - u.pos.x);
        if (u.attackTimer <= 0 && cls.meleeDps > 0) {
          enemy.hp -= cls.meleeDps;
          enemy.hitFlash = 0.18;
          u.attackTimer = 1;
          if (enemy.hp <= 0) {
            const ef = world.formationByUnit[enemy.id];
            if (ef) killUnit(world, ef, enemy);
          }
        }
      } else {
        // 敌人在探测带但还没贴上：保持行军，由 slot 追踪把人顶上去
        u.state = 'march';
        u.targetId = enemy.id;
        formationContact = true;
      }
    }

    // 接敌滞回：一旦接触，保持 3s 接敌状态，避免缠斗中瞬时丢目标导致
    // 锚点反复启停、以及脱战帧的大误差污染稳态统计
    if (formationContact) {
      f.engaged = true;
      f.disengageClock = 3;
    } else if (f.disengageClock > 0) {
      f.disengageClock -= dt;
      if (f.disengageClock <= 0) {
        f.engaged = false;
        // 脱战后残阵在厮杀中散开，开一个重排窗口把单位收拢回 slot，
        // 避免散开的阵型以高误差进入后续行军统计
        f.reformClock = 2.0;
        f.reformConvergedFrames = 0;
      }
    }
  }
}
