/** Canvas2D 渲染器：地形、阵型槽位、单位（按兵种形状/队伍配色）、投射物与接敌高亮 */
import type { World } from '../core/runtime';
import type { FormationRuntime } from '../core/runtime';
import type { Terrain, Unit } from '../core/types';
import { localToWorld } from '../core/math';

const TERRAIN_FILL: Record<string, string> = {
  grass: '#3a4a35',
  mud: '#5a4a32',
  forest: '#2c4028',
  hill: '#4d5540',
  water: '#27415e',
  bridge: '#7a6446',
  road: '#6b6250'
};

const TEAM_TINT = ['#4a90d9', '#d9534f'];

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private terrainCanvas: HTMLCanvasElement;

  constructor(private canvas: HTMLCanvasElement, private terrain: Terrain) {
    this.ctx = canvas.getContext('2d')!;
    this.terrainCanvas = document.createElement('canvas');
    this.bakeTerrain();
  }

  /** 把静态地形烘焙到离屏画布，每帧只 drawImage，避免逐格重绘 */
  private bakeTerrain(): void {
    const t = this.terrain;
    this.terrainCanvas.width = t.cols;
    this.terrainCanvas.height = t.rows;
    const tctx = this.terrainCanvas.getContext('2d')!;
    const img = tctx.createImageData(t.cols, t.rows);
    const ids = ['grass', 'mud', 'forest', 'hill', 'water', 'bridge', 'road'];
    for (let i = 0; i < t.cell.length; i++) {
      const fill = TERRAIN_FILL[ids[t.cell[i]]] ?? TERRAIN_FILL.grass;
      const r = parseInt(fill.slice(1, 3), 16);
      const g = parseInt(fill.slice(3, 5), 16);
      const b = parseInt(fill.slice(5, 7), 16);
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = 255;
    }
    tctx.putImageData(img, 0, 0);
  }

  clear(): void {
    this.ctx.fillStyle = '#14181c';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  drawTerrain(cam: Camera): void {
    const t = this.terrain;
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(
      this.terrainCanvas,
      0, 0, t.cols, t.rows,
      -cam.x * cam.zoom, -cam.y * cam.zoom,
      t.cols * t.cellSize * cam.zoom, t.rows * t.cellSize * cam.zoom
    );
  }

  private worldToScreen(x: number, y: number, cam: Camera): [number, number] {
    return [(x - cam.x) * cam.zoom, (y - cam.y) * cam.zoom];
  }

  /** 绘制阵型槽位骨架（编辑器/调试用） */
  drawFormationSlots(f: FormationRuntime, cam: Camera, alpha = 0.5): void {
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = TEAM_TINT[f.spec.team] ?? '#aaa';
    ctx.lineWidth = 1;
    for (const s of f.layout.slots) {
      const w = localToWorld(f.anchor, f.angle, s.local);
      const [sx, sy] = this.worldToScreen(w.x, w.y, cam);
      ctx.strokeRect(sx - 2, sy - 2, 4, 4);
    }
    ctx.globalAlpha = 1;
    // 锚点
    const [ax, ay] = this.worldToScreen(f.anchor.x, f.anchor.y, cam);
    ctx.fillStyle = '#ffd24a';
    ctx.beginPath();
    ctx.arc(ax, ay, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  drawUnits(world: World, cam: Camera): void {
    const ctx = this.ctx;
    const r = Math.max(1.6, 0.32 * cam.zoom);
    for (const u of world.units) {
      if (!u.alive) continue;
      const [sx, sy] = this.worldToScreen(u.pos.x, u.pos.y, cam);
      const cls = world.classes.get(u.cls)!;
      const base = cls.color;
      ctx.fillStyle = u.hitFlash > 0 ? '#ffffff' : base;
      ctx.strokeStyle = TEAM_TINT[u.team] ?? '#000';
      ctx.lineWidth = 1.2;
      this.unitShape(ctx, u, sx, sy, r);
      if (u.state === 'rout') {
        ctx.fillStyle = '#ff5252';
        ctx.font = '8px monospace';
        ctx.fillText('!', sx - 1, sy - 4);
      }
    }
  }

  private unitShape(ctx: CanvasRenderingContext2D, u: Unit, x: number, y: number, r: number): void {
    ctx.beginPath();
    switch (u.cls) {
      case 'cavalry':
        // 菱形
        ctx.moveTo(x, y - r * 1.3);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r * 1.3);
        ctx.lineTo(x - r, y);
        ctx.closePath();
        break;
      case 'ram':
      case 'catapult':
        // 方形（器械）
        ctx.rect(x - r * 1.3, y - r * 1.3, r * 2.6, r * 2.6);
        break;
      case 'archer':
      case 'crossbow':
        // 三角（远程）
        ctx.moveTo(x, y - r * 1.3);
        ctx.lineTo(x + r * 1.1, y + r);
        ctx.lineTo(x - r * 1.1, y + r);
        ctx.closePath();
        break;
      default:
        // 圆形（步兵）
        ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();
  }

  drawProjectiles(world: World, cam: Camera): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#ffcf6b';
    for (const p of world.projectiles) {
      if (!p.alive) continue;
      const [sx, sy] = this.worldToScreen(p.pos.x, p.pos.y, cam);
      ctx.beginPath();
      ctx.arc(sx, sy, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawWaypoints(world: World, cam: Camera): void {
    const ctx = this.ctx;
    for (const f of world.formations) {
      if (f.waypoints.length === 0) continue;
      ctx.strokeStyle = TEAM_TINT[f.spec.team] ?? '#aaa';
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      const [sx0, sy0] = this.worldToScreen(f.anchor.x, f.anchor.y, cam);
      ctx.moveTo(sx0, sy0);
      for (let i = f.wpIndex; i < f.waypoints.length; i++) {
        const [sx, sy] = this.worldToScreen(f.waypoints[i].x, f.waypoints[i].y, cam);
        ctx.lineTo(sx, sy);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  frame(world: World, cam: Camera, showSlots: boolean): void {
    this.clear();
    this.drawTerrain(cam);
    this.drawWaypoints(world, cam);
    if (showSlots) for (const f of world.formations) this.drawFormationSlots(f, cam, 0.4);
    this.drawUnits(world, cam);
    this.drawProjectiles(world, cam);
  }
}
