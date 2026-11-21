/** 模拟器：固定步长推进，汇总行军与战斗，并测量每帧逻辑耗时 */
import type { World } from './runtime';
import { SpatialHash, updateMovement } from './movement';
import { updateCombat, updateProjectiles } from './combat';
import { findPath } from './pathfinding';

export const FIXED_DT = 1 / 30;

export class Simulator {
  readonly world: World;
  private hash: SpatialHash;
  private accumulator = 0;

  constructor(world: World) {
    this.world = world;
    this.hash = new SpatialHash(world.terrain.width, world.terrain.height, 4);
  }

  /** 给某个阵型下达到目标点的军令（自动寻路，含过桥路线） */
  issueMove(formationId: number, x: number, y: number): boolean {
    const f = this.world.formations.find((rf) => rf.spec.id === formationId);
    if (!f) return false;
    const path = findPath(this.world.terrain, f.anchor, { x, y });
    if (!path) return false;
    f.waypoints = path.points.slice(1); // 第一个点是当前格
    f.wpIndex = 0;
    f.engaged = false;
    return true;
  }

  /** 全线进攻：每个阵型寻路到对岸纵深（跨河、必走窄桥），x 维持本列以减少横向穿插 */
  issueGeneralAdvance(targetY?: number): void {
    const t = this.world.terrain;
    for (const f of this.world.formations) {
      // 蓝军在河北岸朝南进攻 → 推进到南岸；红军反向
      const goalY = targetY ?? (f.spec.team === 0 ? t.height - 8 : 8);
      this.issueMove(f.spec.id, f.anchor.x, goalY);
    }
  }

  /** 推进一帧固定步长，返回逻辑耗时（毫秒） */
  step(dt: number = FIXED_DT): number {
    const start = nowMicros();
    const world = this.world;
    world.time += dt;

    updateMovement(world, dt, this.hash);
    updateCombat(world, dt, this.hash);
    updateProjectiles(world, dt);

    const elapsed = (nowMicros() - start) / 1000;
    world.frameMs = elapsed;
    return elapsed;
  }

  /** 可变帧率入口：内部累积器拆固定步长，返回本帧执行的步数 */
  update(frameDeltaSeconds: number): number {
    this.accumulator += Math.min(frameDeltaSeconds, 0.1);
    let steps = 0;
    while (this.accumulator >= FIXED_DT) {
      this.step(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    return steps;
  }

  get slotErrors(): { avg: number; max: number } {
    let avg = 0;
    let max = 0;
    let n = 0;
    for (const f of this.world.formations) {
      if (f.avgSlotError > 0) {
        avg += f.avgSlotError;
        max = Math.max(max, f.maxSlotError);
        n++;
      }
    }
    return { avg: n ? avg / n : 0, max };
  }

  get aliveCounts(): { team0: number; team1: number } {
    let team0 = 0;
    let team1 = 0;
    for (const u of this.world.units) {
      if (!u.alive) continue;
      if (u.team === 0) team0++;
      else team1++;
    }
    return { team0, team1 };
  }
}

function nowMicros(): number {
  // 浏览器与 Node 18+ 都在全局提供高精度 performance.now()
  return performance.now() * 1000;
}
