/** 阵型编辑页：选择阵型、调整兵种混编比例，实时预览槽位排布与成型效果 */
import type { FormationType, UnitClassId } from '../core/types';
import { createPreviewFormation } from '../core/scenario';
import type { World } from '../core/runtime';
import { Renderer, type Camera } from './renderer';

const FORMATION_NAMES: Record<FormationType, string> = {
  phalanx: '密集方阵',
  line: '横队',
  wedge: '楔形',
  square: '方阵城',
  column: '纵队'
};

const EDITABLE: UnitClassId[] = ['spear', 'pike', 'sword', 'archer', 'crossbow', 'cavalry', 'ram', 'catapult'];
const CLASS_LABEL: Record<UnitClassId, string> = {
  spear: '长枪兵', pike: '长矛方阵兵', sword: '盾剑士', archer: '弓手',
  crossbow: '弩手', cavalry: '骑兵', ram: '攻城槌', catapult: '投石机'
};

export class EditorPage {
  private type: FormationType = 'phalanx';
  private counts = new Map<UnitClassId, number>([
    ['spear', 40], ['pike', 20], ['sword', 16],
    ['archer', 14], ['crossbow', 0], ['cavalry', 6], ['ram', 2], ['catapult', 2]
  ]);
  private renderer: Renderer | null = null;
  private cam: Camera = { x: 0, y: 0, zoom: 14 };

  constructor(private root: HTMLElement) {}

  mount(): void {
    this.root.innerHTML = `
      <div class="editor-wrap">
        <aside class="editor-panel">
          <h3>阵型编辑</h3>
          <label class="field">阵型
            <select id="f-type">
              ${(Object.keys(FORMATION_NAMES) as FormationType[]).map(
                (t) => `<option value="${t}" ${t === this.type ? 'selected' : ''}>${FORMATION_NAMES[t]}</option>`
              ).join('')}
            </select>
          </label>
          <div class="field"><span>兵种混编（人数）</span><div id="f-classes"></div></div>
          <div class="field"><span>总人数 <b id="f-total">0</b></span></div>
          <label class="field checkbox"><input type="checkbox" id="f-slots" checked> 显示槽位骨架</label>
          <div class="hint">排位规则：长枪/长矛前排，盾剑中层，弓弩后排；骑兵占两翼，攻城器械居后居中。</div>
        </aside>
        <div class="canvas-wrap">
          <canvas id="editor-canvas" width="900" height="640"></canvas>
          <div id="f-meta" class="overlay-meta"></div>
        </div>
      </div>`;

    this.root.querySelector<HTMLSelectElement>('#f-type')!.addEventListener('change', (e) => {
      this.type = (e.target as HTMLSelectElement).value as FormationType;
      this.rebuild();
    });
    this.root.querySelector<HTMLInputElement>('#f-slots')!.addEventListener('change', () => this.rebuild());
    this.buildClassEditors();
    this.rebuild();
  }

  private buildClassEditors(): void {
    const host = this.root.querySelector('#f-classes')!;
    host.innerHTML = EDITABLE.map((id) => `
      <div class="class-row">
        <span class="class-dot" style="background:var(--c-${id})"></span>
        <span class="class-name">${CLASS_LABEL[id]}</span>
        <input type="range" min="0" max="60" step="2" value="${this.counts.get(id) ?? 0}" data-cls="${id}">
        <b data-val="${id}">${this.counts.get(id) ?? 0}</b>
      </div>`).join('');
    host.querySelectorAll('input[type=range]').forEach((input) => {
      input.addEventListener('input', (e) => {
        const el = e.target as HTMLInputElement;
        this.counts.set(el.dataset.cls as UnitClassId, Number(el.value));
        this.root.querySelector(`[data-val="${el.dataset.cls}"]`)!.textContent = el.value;
        this.rebuild();
      });
    });
  }

  private rebuild(): void {
    const composition = EDITABLE
      .map((cls) => ({ cls, count: this.counts.get(cls) ?? 0 }))
      .filter((c) => c.count > 0);
    const total = composition.reduce((s, c) => s + c.count, 0);
    this.root.querySelector('#f-total')!.textContent = String(total);
    const meta = this.root.querySelector('#f-meta')!;
    if (total === 0) {
      meta.textContent = '至少编入一个兵种';
      return;
    }
    const { rt, terrain, classes } = createPreviewFormation(this.type, composition);
    const canvas = this.root.querySelector<HTMLCanvasElement>('#editor-canvas')!;
    this.renderer = new Renderer(canvas, terrain);
    this.cam = { x: rt.anchor.x - 32, y: rt.anchor.y - 23, zoom: 14 };
    const showSlots = this.root.querySelector<HTMLInputElement>('#f-slots')!.checked;

    const world: World = {
      units: rt.units,
      formations: [rt],
      formationByUnit: [],
      projectiles: [],
      terrain,
      classes,
      nextUnitId: rt.units.length,
      time: 0,
      searchTick: 0,
      frameMs: 0
    };
    this.renderer.frame(world, this.cam, showSlots);
    meta.innerHTML = `阵型 <b>${FORMATION_NAMES[this.type]}</b> · 宽 ${rt.layout.width.toFixed(1)}m · 纵深 ${rt.layout.depth.toFixed(1)}m · ${rt.units.length} 人 · ${rt.layout.rows.length} 排`;
  }

  dispose(): void {
    this.renderer = null;
  }
}
