/** 领域类型定义 */
import type { Vec2 } from './math';

export type UnitClassId =
  | 'spear'
  | 'sword'
  | 'pike'
  | 'archer'
  | 'crossbow'
  | 'cavalry'
  | 'ram'
  | 'catapult';

export type TroopKind = 'melee' | 'ranged' | 'cavalry' | 'siege';

export interface UnitClass {
  id: UnitClassId;
  name: string;
  kind: TroopKind;
  /** 基础移速 米/秒 */
  speed: number;
  /** 占位间距（阵型 slot 间距的一半口径由 formation 统一处理，这里是参考值）米 */
  spacing: number;
  /** 生命值 */
  hp: number;
  /** 近战每秒伤害 */
  meleeDps: number;
  /** 远程射程（米），0 表示无远程能力 */
  range: number;
  /** 远程单发伤害 */
  rangedDamage: number;
  /** 远程攻击间隔（秒） */
  rangedCooldown: number;
  /** 近战交战距离（米） */
  engageDist: number;
  /** 颜色（渲染用） */
  color: string;
}

export type FormationType = 'phalanx' | 'line' | 'wedge' | 'square' | 'column';

export type UnitState = 'march' | 'melee' | 'firing' | 'rout';

export interface Unit {
  id: number;
  team: number;
  cls: UnitClassId;
  /** 当前世界坐标（米） */
  pos: Vec2;
  /** 当前速度分量（米/秒） */
  velX: number;
  velY: number;
  /** 当前朝向（弧度） */
  angle: number;
  hp: number;
  maxHp: number;
  state: UnitState;
  /** 所属阵型 id，-1 表示无编队 */
  formationId: number;
  /** 阵型内 slot 序号 */
  slotIndex: number;
  /** 攻击冷却计时 */
  attackTimer: number;
  /** 当前目标单位 id，-1 无 */
  targetId: number;
  /** 受击/补位用的轻微抖动计时（不影响逻辑正确性，仅渲染） */
  hitFlash: number;
  alive: boolean;
}

/** 阵型内一个槽位的局部坐标（米，+x 为前方） */
export interface Slot {
  local: Vec2;
  /** 所属行（0 = 最前排），用于阵亡补位 */
  row: number;
  /** 所属列 */
  col: number;
}

export interface ClassRatio {
  cls: UnitClassId;
  count: number;
}

export interface FormationSpec {
  id: number;
  name: string;
  type: FormationType;
  team: number;
  /** 混编比例（数量） */
  composition: ClassRatio[];
  /** 锚点世界坐标 */
  anchor: Vec2;
  /** 朝向（弧度，+x 方向） */
  angle: number;
}

export type TerrainType = 'grass' | 'mud' | 'forest' | 'hill' | 'water' | 'bridge' | 'road';

export interface Terrain {
  width: number;
  height: number;
  /** 2m 方格上的地形类型编码（见 terrain.ts TERRAIN_IDS） */
  cell: Uint8Array;
  cellSize: number;
  cols: number;
  rows: number;
  /** 河流中心线 y（世界坐标），-1 表示无河 */
  riverY: number;
  /** 桥的 x 区间（世界坐标） */
  bridges: { x0: number; x1: number }[];
}

export interface Projectile {
  pos: Vec2;
  targetId: number;
  speed: number;
  damage: number;
  team: number;
  alive: boolean;
}
