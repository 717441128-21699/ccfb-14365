/** 对战沙盘页：1000 单位隔河会战，支持播放控制、点选阵型下令与实时性能 HUD */
import { createScenario } from '../core/scenario';
import { Simulator } from '../core/simulator';
import { Renderer, type Camera } from './renderer';
import { dist } from '../core/math';
import type { FormationRuntime } from '../core/runtime';

export class SandboxPage {
  private sim: Simulator | null = null;
  private renderer: Renderer | null = null;
  private cam: Camera = { x: -4, y: -4, zoom: 8 };
  private running = false;
  private speedMul = 1;
  private raf = 0;
  private lastTs = 0;
  private selected: FormationRuntime | null = null;
  private showSlots = false;

  constructor(private root: HTMLElement) {}

  mount(): void {
    this.root.innerHTML = `
      <div class="sandbox-wrap">
        <div class="toolbar">
          <button id="b-play" class="primary">开战</button>
          <button id="b-pause">暂停</button>
          <button id="b-reset">重置</button>
          <label class="speed">倍速
            <select id="b-speed">
              <option value="1">1×</option>
              <option value="2">2×</option>
              <option value="4">4×</option>
            </select>
          </label>
          <button id="b-advance">全线进攻</button>
          <label class="speed checkbox"><input type="checkbox" id="b-slots"> 槽位骨架</label>
          <span class="tip">点击阵型选中，再点地图下令（自动寻路过桥）</span>
        </div>
        <div class="canvas-wrap">
          <canvas id="sandbox-canvas" width="1080" height="700"></canvas>
          <div id="hud" class="hud"></div>
          <div id="sel-info" class="sel-info"></div>
        </div>
      </div>`;

    const canvas = this.root.querySelector<HTMLCanvasElement>('#sandbox-canvas')!;
    const scenario = createScenario();
    this.sim = new Simulator(scenario.world);
    this.renderer = new Renderer(canvas, scenario.world.terrain);
    this.cam = this.fitCamera(canvas);

    this.root.querySelector('#b-play')!.addEventListener('click', () => { this.running = true; });
    this.root.querySelector('#b-pause')!.addEventListener('click', () => { this.running = false; });
    this.root.querySelector('#b-reset')!.addEventListener('click', () => this.reset());
    this.root.querySelector('#b-speed')!.addEventListener('change', (e) => {
      this.speedMul = Number((e.target as HTMLSelectElement).value);
    });
    this.root.querySelector('#b-advance')!.addEventListener('click', () => this.sim!.issueGeneralAdvance());
    this.root.querySelector('#b-slots')!.addEventListener('change', (e) => {
      this.showSlots = (e.target as HTMLInputElement).checked;
    });
    canvas.addEventListener('click', (e) => this.onCanvasClick(e, canvas));

    this.lastTs = performance.now();
    const loop = (ts: number): void => {
      const frameDelta = Math.min(0.1, (ts - this.lastTs) / 1000) * this.speedMul;
      this.lastTs = ts;
      if (this.running && this.sim) this.sim.update(frameDelta);
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private fitCamera(canvas: HTMLCanvasElement): Camera {
    const t = this.sim!.world.terrain;
    const zoom = Math.min(canvas.width / (t.width + 8), canvas.height / (t.height + 8));
    return { x: -4, y: -4, zoom };
  }

  private reset(): void {
    const scenario = createScenario();
    this.sim = new Simulator(scenario.world);
    this.selected = null;
    this.running = false;
    const canvas = this.root.querySelector<HTMLCanvasElement>('#sandbox-canvas')!;
    this.renderer = new Renderer(canvas, scenario.world.terrain);
    this.cam = this.fitCamera(canvas);
  }

  private onCanvasClick(e: MouseEvent, canvas: HTMLCanvasElement): void {
    if (!this.sim) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wx = sx / this.cam.zoom + this.cam.x;
    const wy = sy / this.cam.zoom + this.cam.y;

    // 先尝试选中锚点附近的阵型
    let hit: FormationRuntime | null = null;
    let bestD = 6;
    for (const f of this.sim.world.formations) {
      const d = dist(f.anchor, { x: wx, y: wy });
      if (d < bestD) {
        bestD = d;
        hit = f;
      }
    }
    if (hit) {
      this.selected = hit;
      return;
    }
    // 已选中阵型则对点击点下令
    if (this.selected) {
      this.sim.issueMove(this.selected.spec.id, wx, wy);
    }
  }

  private draw(): void {
    if (!this.sim || !this.renderer) return;
    const world = this.sim.world;
    this.renderer.frame(world, this.cam, this.showSlots);

    // 选中高亮
    if (this.selected) {
      const ctx = this.root.querySelector<HTMLCanvasElement>('#sandbox-canvas')!.getContext('2d')!;
      const [x, y] = [
        (this.selected.anchor.x - this.cam.x) * this.cam.zoom,
        (this.selected.anchor.y - this.cam.y) * this.cam.zoom
      ];
      ctx.strokeStyle = '#ffd24a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.stroke();
    }

    const alive = this.sim.aliveCounts;
    const err = this.sim.slotErrors;
    document.querySelector('#hud')!.innerHTML = `
      <div>帧逻辑 <b class="${world.frameMs > 5 ? 'bad' : 'good'}">${world.frameMs.toFixed(2)}ms</b></div>
      <div>保持误差 avg <b>${err.avg.toFixed(2)}m</b> max <b>${err.max.toFixed(2)}m</b></div>
      <div>蓝军 <b style="color:#4a90d9">${alive.team0}</b> · 红军 <b style="color:#d9534f">${alive.team1}</b></div>
      <div>投射物 ${world.projectiles.length} · t=${world.time.toFixed(1)}s</div>`;

    const sel = this.selected;
    document.querySelector('#sel-info')!.textContent = sel
      ? `${sel.spec.name} | ${sel.chokeMode} | 锚点(${sel.anchor.x.toFixed(0)},${sel.anchor.y.toFixed(0)}) | 走廊宽${sel.chokeWidth.toFixed(1)}m | 航点${sel.wpIndex}/${sel.waypoints.length}`
      : '未选中阵型';
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
  }
}
