/** 兵种表：参数由种子随机生成，再覆盖关键兵种的定位，保证八个兵种各司其职 */
import type { UnitClass, UnitClassId } from './types';
import { Rng } from './math';

interface ClassTemplate {
  id: UnitClassId;
  name: string;
  kind: UnitClass['kind'];
  speed: [number, number];
  spacing: number;
  hp: [number, number];
  meleeDps: [number, number];
  range: number;
  rangedDamage: [number, number];
  rangedCooldown: number;
  engageDist: number;
  color: string;
}

const TEMPLATES: ClassTemplate[] = [
  {
    id: 'spear', name: '长枪兵', kind: 'melee',
    speed: [3.4, 3.8], spacing: 1.6, hp: [95, 115], meleeDps: [9, 12],
    range: 0, rangedDamage: [0, 0], rangedCooldown: 0, engageDist: 2.2, color: '#5b8c5a'
  },
  {
    id: 'pike', name: '长矛方阵兵', kind: 'melee',
    speed: [2.8, 3.2], spacing: 1.5, hp: [110, 130], meleeDps: [11, 14],
    range: 0, rangedDamage: [0, 0], rangedCooldown: 0, engageDist: 3.0, color: '#3f6d4e'
  },
  {
    id: 'sword', name: '盾剑士', kind: 'melee',
    speed: [3.8, 4.3], spacing: 1.6, hp: [100, 120], meleeDps: [12, 15],
    range: 0, rangedDamage: [0, 0], rangedCooldown: 0, engageDist: 1.8, color: '#7a8fb0'
  },
  {
    id: 'archer', name: '弓手', kind: 'ranged',
    speed: [3.6, 4.0], spacing: 1.7, hp: [60, 75], meleeDps: [4, 6],
    range: 42, rangedDamage: [10, 14], rangedCooldown: 1.4, engageDist: 1.6, color: '#c9a85a'
  },
  {
    id: 'crossbow', name: '弩手', kind: 'ranged',
    speed: [3.2, 3.6], spacing: 1.7, hp: [70, 85], meleeDps: [5, 7],
    range: 34, rangedDamage: [16, 20], rangedCooldown: 2.4, engageDist: 1.6, color: '#b08d57'
  },
  {
    id: 'cavalry', name: '骑兵', kind: 'cavalry',
    speed: [7.5, 8.5], spacing: 2.6, hp: [130, 155], meleeDps: [18, 24],
    range: 0, rangedDamage: [0, 0], rangedCooldown: 0, engageDist: 2.4, color: '#9c6b3f'
  },
  {
    id: 'ram', name: '攻城槌', kind: 'siege',
    speed: [1.4, 1.7], spacing: 4.0, hp: [260, 320], meleeDps: [30, 40],
    range: 0, rangedDamage: [0, 0], rangedCooldown: 0, engageDist: 3.2, color: '#6e5a49'
  },
  {
    id: 'catapult', name: '投石机', kind: 'siege',
    speed: [1.1, 1.4], spacing: 4.5, hp: [140, 180], meleeDps: [0, 0],
    range: 60, rangedDamage: [34, 44], rangedCooldown: 5.0, engageDist: 3.0, color: '#8a7f6d'
  }
];

/** 用种子生成一套兵种数值（在模板区间内抖动，保证可复现） */
export function generateClasses(seed: number): Map<UnitClassId, UnitClass> {
  const rng = new Rng(seed);
  const map = new Map<UnitClassId, UnitClass>();
  for (const t of TEMPLATES) {
    map.set(t.id, {
      id: t.id,
      name: t.name,
      kind: t.kind,
      speed: rng.range(t.speed[0], t.speed[1]),
      spacing: t.spacing,
      hp: Math.round(rng.range(t.hp[0], t.hp[1])),
      meleeDps: rng.range(t.meleeDps[0], t.meleeDps[1]),
      range: t.range,
      rangedDamage: t.range > 0 ? rng.range(t.rangedDamage[0], t.rangedDamage[1]) : 0,
      rangedCooldown: t.rangedCooldown,
      engageDist: t.engageDist,
      color: t.color
    });
  }
  return map;
}

export const CLASS_ORDER: UnitClassId[] = [
  'spear', 'pike', 'sword', 'archer', 'crossbow', 'cavalry', 'ram', 'catapult'
];
