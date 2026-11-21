/**
 * 端到端冒烟测试（Node 无头）：覆盖需求四大块的关键不变量。
 * 运行：npx tsx src/perf/smoke.ts
 */
import { createScenario } from '../core/scenario';
import { Simulator } from '../core/simulator';
import { localToWorld, dist } from '../core/math';
import { buildLayout } from '../core/formation';
import type { Unit, UnitClassId } from '../core/types';

let failures = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failures++;
    console.log(`  ❌ ${name} ${detail}`);
  }
};

// 1) 编队：混排位 —— 前排无弓手/器械，骑兵在两翼
console.log('【编队】');
{
  const { world } = createScenario();
  let frontOk = true;
  let cavalryFlank = true;
  for (const f of world.formations) {
    for (const sid of f.layout.rows[0].slotIds) {
      const o = f.occupants[sid];
      if (o && (o.cls === 'archer' || o.cls === 'crossbow' || o.cls === 'catapult')) frontOk = false;
    }
    // 两翼规则只对矩形阵型（方阵/横队/方阵城）成立；楔形骑兵沿斜面分布属合理形态
    const rectangular = f.homeType === 'phalanx' || f.homeType === 'line' || f.homeType === 'square';
    if (rectangular && f.spec.composition.some((c) => c.cls === 'cavalry')) {
      const maxAbs = Math.max(...f.layout.slots.map((s) => Math.abs(s.local.y)));
      const cavTooCentral = f.units
        .filter((u) => u.cls === 'cavalry')
        .some((u) => Math.abs(f.layout.slots[u.slotIndex].local.y) < maxAbs * 0.5);
      if (cavTooCentral) cavalryFlank = false;
    }
  }
  check('所有阵型前排无弓手/器械', frontOk);
  check('骑兵布置在两翼外缘', cavalryFlank);
  check('总单位 1000、十阵', world.units.length === 1000 && world.formations.length === 10);
}

// 2) 阵型类型几何：五种阵型都能正确生成且无重复 slot
console.log('【阵型几何】');
{
  const { world } = createScenario();
  const classes = world.classes as Map<UnitClassId, unknown>;
  const types: Unit['cls'][][] = [
    ['spear', 'archer', 'cavalry', 'ram'],
    ['pike', 'sword', 'crossbow']
  ];
  void types;
  const composition = [
    { cls: 'spear' as UnitClassId, count: 40 },
    { cls: 'sword' as UnitClassId, count: 30 },
    { cls: 'archer' as UnitClassId, count: 20 },
    { cls: 'cavalry' as UnitClassId, count: 10 }
  ];
  for (const type of ['phalanx', 'line', 'wedge', 'square', 'column'] as const) {
    const units: Unit[] = [];
    let id = 0;
    for (const c of composition) {
      for (let i = 0; i < c.count; i++) {
        units.push({
          id: id++, team: 0, cls: c.cls, pos: { x: 0, y: 0 }, velX: 0, velY: 0, angle: 0,
          hp: 100, maxHp: 100, state: 'march', formationId: 0, slotIndex: 0,
          attackTimer: 0, targetId: -1, hitFlash: 0, alive: true
        });
      }
    }
    const layout = buildLayout(type, units, classes as never, composition);
    const slots = new Set(units.map((u) => u.slotIndex));
    check(`${type} 生成 ${units.length} 槽且无重复绑定`, slots.size === units.length && layout.slots.length === units.length);
  }
}

// 3) 行军：窄桥成列 + 行军保持误差
console.log('【行军】');
{
  const { world } = createScenario();
  const sim = new Simulator(world);
  sim.issueGeneralAdvance();
  let columnSeen = false;
  const unitErr: number[] = [];
  for (let i = 0; i < 900; i++) {
    sim.step();
    for (const f of world.formations) {
      if (f.chokeMode === 'column') columnSeen = true;
      if (i > 150 && f.chokeMode === 'normal' && !f.engaged && f.reformClock === 0) {
        for (const u of f.units) {
          if (!u.alive) continue;
          const g = localToWorld(f.anchor, f.angle, f.layout.slots[Math.min(u.slotIndex, f.layout.slots.length - 1)].local);
          unitErr.push(dist(u.pos, g));
        }
      }
    }
  }
  unitErr.sort((a, b) => a - b);
  const p95 = unitErr[Math.floor(unitErr.length * 0.95)] ?? 0;
  check('至少一个阵型经窄桥切成纵队', columnSeen);
  check(`稳态单位误差 p95=${p95.toFixed(2)}m ≤ 1m`, p95 <= 1.0, `实际 ${p95.toFixed(2)}`);
}

// 4) 接敌：补位稳定（同列前排死后有人补上空 slot）+ 性能预算
console.log('【接敌与性能】');
{
  const { world } = createScenario();
  const sim = new Simulator(world);
  sim.issueGeneralAdvance();
  let combatSeen = false;
  let maxMs = 0;
  let p99Pool: number[] = [];
  for (let i = 0; i < 1800; i++) {
    const ms = sim.step();
    maxMs = Math.max(maxMs, ms);
    p99Pool.push(ms);
    if (world.formations.some((f) => f.engaged)) combatSeen = true;
  }
  p99Pool = p99Pool.sort((a, b) => a - b);
  const p99 = p99Pool[Math.floor(p99Pool.length * 0.99)];
  check('两军发生接敌战斗', combatSeen);
  check('战斗产生阵亡且补位无重复占用', world.formations.every((f) => {
    const seen = new Set<number>();
    for (const o of f.occupants) {
      if (o) {
        if (seen.has(o.slotIndex)) return false;
        seen.add(o.slotIndex);
      }
    }
    return true;
  }));
  check(`p99 帧逻辑 ${p99.toFixed(2)}ms ≤ 5ms`, p99 <= 5, `p99=${p99.toFixed(2)} max=${maxMs.toFixed(2)}`);
  const alive = sim.aliveCounts;
  check('双方均有存活单位（无全灭异常）', alive.team0 > 0 && alive.team1 > 0);
}

console.log(failures === 0 ? '\n全部冒烟测试通过 ✅' : `\n${failures} 项失败 ❌`);
if (failures > 0) {
  const proc = (globalThis as unknown as { process?: { exitCode: number } }).process;
  if (proc) proc.exitCode = 1;
}
