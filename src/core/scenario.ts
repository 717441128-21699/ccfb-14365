/** 对战场景生成：两军各 5 个混编阵，共 1000 人，隔河列阵 */
import type { FormationSpec, FormationType, Terrain, Unit, UnitClass, UnitClassId } from './types';
import { generateClasses } from './classes';
import { createFormationRuntime, type FormationRuntime, type World } from './runtime';
import { localToWorld } from './math';
import { generateTerrain } from './terrain';

export interface Scenario {
  world: World;
  specs: FormationSpec[];
}

interface ArmyTemplate {
  type: FormationType;
  name: string;
  composition: { cls: UnitClassId; count: number }[];
}

/** 每军 5 阵、每阵 100 人，合计 1000 */
const ARMY: ArmyTemplate[] = [
  {
    type: 'phalanx',
    name: '长枪方阵',
    composition: [
      { cls: 'pike', count: 60 },
      { cls: 'spear', count: 20 },
      { cls: 'archer', count: 20 }
    ]
  },
  {
    type: 'line',
    name: '步射横队',
    composition: [
      { cls: 'spear', count: 34 },
      { cls: 'sword', count: 20 },
      { cls: 'archer', count: 30 },
      { cls: 'crossbow', count: 16 }
    ]
  },
  {
    type: 'wedge',
    name: '骑兵楔阵',
    composition: [
      { cls: 'cavalry', count: 48 },
      { cls: 'sword', count: 40 },
      { cls: 'archer', count: 12 }
    ]
  },
  {
    type: 'square',
    name: '器械方阵城',
    composition: [
      { cls: 'spear', count: 44 },
      { cls: 'sword', count: 30 },
      { cls: 'crossbow', count: 14 },
      { cls: 'ram', count: 4 },
      { cls: 'catapult', count: 8 }
    ]
  },
  {
    type: 'phalanx',
    name: '盾剑混编方阵',
    composition: [
      { cls: 'sword', count: 50 },
      { cls: 'spear', count: 30 },
      { cls: 'archer', count: 14 },
      { cls: 'cavalry', count: 6 }
    ]
  }
];

export function createScenario(seed = 20261122): Scenario {
  const classes = generateClasses(seed);
  const terrain = generateTerrain(seed + 7);
  const units: Unit[] = [];
  const specs: FormationSpec[] = [];
  const formations: FormationRuntime[] = [];
  let unitId = 0;
  let formationId = 0;

  const buildArmy = (team: number, baseAngle: number, anchors: { x: number; y: number }[]): void => {
    ARMY.forEach((tpl, idx) => {
      const total = tpl.composition.reduce((s, c) => s + c.count, 0);
      const spec: FormationSpec = {
        id: formationId,
        name: `${team === 0 ? '蓝' : '红'}军·${tpl.name}`,
        type: tpl.type,
        team,
        composition: tpl.composition.map((c) => ({ ...c })),
        anchor: { x: anchors[idx].x, y: anchors[idx].y },
        angle: baseAngle
      };
      const localUnits: Unit[] = [];
      for (const c of tpl.composition) {
        for (let i = 0; i < c.count; i++) {
          const cls = classes.get(c.cls)!;
          localUnits.push({
            id: unitId++,
            team,
            cls: c.cls,
            pos: { x: 0, y: 0 },
            velX: 0,
            velY: 0,
            angle: baseAngle,
            hp: cls.hp,
            maxHp: cls.hp,
            state: 'march',
            formationId,
            slotIndex: 0,
            attackTimer: 0,
            targetId: -1,
            hitFlash: 0,
            alive: true
          });
        }
      }
      const rt = createFormationRuntime(spec, localUnits, classes);
      // 初始位置经完整局部->世界变换落到 slot，开局即成型（含朝向旋转）
      for (const u of localUnits) {
        const slot = rt.layout.slots[u.slotIndex];
        u.pos = localToWorld(rt.anchor, rt.angle, slot.local);
      }
      units.push(...localUnits);
      specs.push(spec);
      formations.push(rt);
      formationId++;
      void total;
    });
  };

  // 河流横向贯穿 y≈47（水面约 y∈[43.4,50.4]），把地图切成南北两岸，
  // 仅有两座窄桥（x≈40 与 x≈92）可通行。
  // 蓝军全部在河北岸（y 小侧）正面朝南，红军全部在河南岸正面朝北，
  // 双方交战必须先沿河岸机动到桥头、成纵队过桥、再展开——窄桥需求由此成为刚需。
  // 阵型半宽 ≤9.6m，五阵沿 x 方向均匀排布且互不越界。
  const blueAnchors = [16, 38, 60, 82, 104].map((x) => ({ x, y: 16 }));
  const redAnchors = [16, 38, 60, 82, 104].map((x) => ({ x, y: 76 }));
  buildArmy(0, Math.PI / 2, blueAnchors);   // 蓝军在河北岸，朝南（+y）
  buildArmy(1, -Math.PI / 2, redAnchors);    // 红军在河南岸，朝北（-y）

  const world: World = {
    units,
    formations,
    formationByUnit: [],
    projectiles: [],
    terrain,
    classes,
    nextUnitId: unitId,
    time: 0,
    searchTick: 0,
    frameMs: 0
  };
  for (const f of formations) {
    for (const u of f.units) world.formationByUnit[u.id] = f;
  }
  return { world, specs };
}

/** 编辑器用的轻量场景：单阵预览 */
export function createPreviewFormation(
  type: FormationType,
  composition: { cls: UnitClassId; count: number }[],
  seed = 99
): { rt: FormationRuntime; terrain: Terrain; classes: Map<UnitClassId, UnitClass> } {
  const classes = generateClasses(seed);
  const terrain = generateTerrain(seed + 3, 60, 44);
  const spec: FormationSpec = {
    id: 0,
    name: '预览',
    type,
    team: 0,
    composition: composition.map((c) => ({ ...c })),
    anchor: { x: 12, y: terrain.height / 2 },
    angle: 0
  };
  const localUnits: Unit[] = [];
  let id = 0;
  for (const c of composition) {
    for (let i = 0; i < c.count; i++) {
      const cls = classes.get(c.cls)!;
      localUnits.push({
        id: id++,
        team: 0,
        cls: c.cls,
        pos: { x: 0, y: 0 },
        velX: 0,
        velY: 0,
        angle: 0,
        hp: cls.hp,
        maxHp: cls.hp,
        state: 'march',
        formationId: 0,
        slotIndex: 0,
        attackTimer: 0,
        targetId: -1,
        hitFlash: 0,
        alive: true
      });
    }
  }
  const rt = createFormationRuntime(spec, localUnits, classes);
  for (const u of localUnits) {
    u.pos = localToWorld(rt.anchor, rt.angle, rt.layout.slots[u.slotIndex].local);
  }
  return { rt, terrain, classes };
}
