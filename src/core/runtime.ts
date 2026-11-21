/** 模拟运行时结构：编队实例、世界容器 */
import type {
  FormationSpec, FormationType, Projectile, Terrain, Unit, UnitClass
} from './types';
import { buildColumnLayout, buildLayout, type Layout } from './formation';

export type ChokeMode = 'normal' | 'approaching' | 'column' | 'reforming';

export interface FormationRuntime {
  spec: FormationSpec;
  units: Unit[];
  /** 当前生效布局（纵队切换时会替换） */
  layout: Layout;
  /** 原始阵型（过桥后恢复用） */
  homeType: FormationType;
  /** 纵队布局缓存 */
  columnLayout: Layout;
  /** slotId -> 当前占用该 slot 的存活单位（补位检索用，随布局切换重建） */
  occupants: (Unit | null)[];
  /** 锚点位置（阵型坐标系原点） */
  anchor: { x: number; y: number };
  angle: number;
  /** 当前速度 米/秒 */
  speed: number;
  /** 编队内最慢兵种速度（混编协调上限） */
  maxSpeed: number;
  waypoints: { x: number; y: number }[];
  wpIndex: number;
  chokeMode: ChokeMode;
  /** 狭窄检测到的可通行宽度 */
  chokeWidth: number;
  /** 状态机计时（秒），用于 reform 滞回 */
  stateTimer: number;
  /** 软重排剩余窗口（秒），窗口内单位允许超速归位，不纳入保持误差统计 */
  reformClock: number;
  /** 重排收敛连续达标帧计数，防止瞬时达标就提前关窗 */
  reformConvergedFrames: number;
  /** 距下次伤亡紧凑重排的冷却（秒） */
  rebuildCooldown: number;
  /** 恢复主战型后禁止再次成列的展开冷却（秒），防抖 */
  columnCooldown: number;
  /** 是否处于接敌状态（接敌后锚点停推） */
  engaged: boolean;
  /** 距上次接敌的脱战计时（秒），用于接敌判定滞回，避免瞬时脱战污染稳态统计 */
  disengageClock: number;
  /** 初始满编兵力，士气判定分母 */
  initialStrength: number;
  /** 平均落点误差（米，渲染/HUD 用） */
  avgSlotError: number;
  maxSlotError: number;
}

export interface World {
  units: Unit[];
  formations: FormationRuntime[];
  /** unitId -> 所属编队运行时，O(1) 查找 */
  formationByUnit: (FormationRuntime | null)[];
  projectiles: Projectile[];
  terrain: Terrain;
  classes: Map<string, UnitClass>;
  nextUnitId: number;
  time: number;
  /** 索敌节流帧计数（奇偶帧分流大范围查询） */
  searchTick: number;
  /** 每帧逻辑耗时（毫秒，由模拟器回填） */
  frameMs: number;
}

export function createFormationRuntime(
  spec: FormationSpec,
  units: Unit[],
  classes: Map<string, UnitClass>
): FormationRuntime {
  const layout = buildLayout(spec.type, units, classes as Map<UnitClass['id'], UnitClass>, spec.composition);
  const spacing = layout.spacing;
  const columnLayout = buildColumnLayout(units.length, spacing);

  let maxSpeed = Infinity;
  for (const c of spec.composition) {
    const cls = classes.get(c.cls)!;
    maxSpeed = Math.min(maxSpeed, cls.speed);
  }

  const rt: FormationRuntime = {
    spec,
    units,
    layout,
    homeType: spec.type,
    columnLayout,
    occupants: new Array(layout.slots.length).fill(null),
    anchor: { ...spec.anchor },
    angle: spec.angle,
    speed: 0,
    maxSpeed: isFinite(maxSpeed) ? maxSpeed : 1.5,
    waypoints: [],
    wpIndex: 0,
    chokeMode: 'normal',
    chokeWidth: 999,
    stateTimer: 0,
    reformClock: 0,
    reformConvergedFrames: 0,
    rebuildCooldown: 0,
    columnCooldown: 0,
    engaged: false,
    disengageClock: 0,
    initialStrength: spec.composition.reduce((s, c) => s + c.count, 0),
    avgSlotError: 0,
    maxSlotError: 0
  };
  rebuildOccupants(rt);
  return rt;
}

/** 按单位当前 slotIndex 重建 slot 占用索引 */
export function rebuildOccupants(f: FormationRuntime): void {
  f.occupants = new Array(f.layout.slots.length).fill(null);
  for (const u of f.units) {
    if (u.alive && u.slotIndex < f.occupants.length) f.occupants[u.slotIndex] = u;
  }
}
