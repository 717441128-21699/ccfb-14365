/** 二维向量与通用数学工具。全部为纯函数，便于在 Node 无头环境复用。 */

export interface Vec2 {
  x: number;
  y: number;
}

export const vec = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const distSq = (a: Vec2, b: Vec2): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

export const normalize = (a: Vec2): Vec2 => {
  const l = Math.hypot(a.x, a.y);
  return l < 1e-9 ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
};

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 角度差归一化到 [-PI, PI] */
export const angleDelta = (from: number, to: number): number => {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

export const headingOf = (angle: number): Vec2 => ({ x: Math.cos(angle), y: Math.sin(angle) });

/** 局部坐标 -> 世界坐标：heading 为 +x 方向 */
export const localToWorld = (origin: Vec2, angle: number, local: Vec2): Vec2 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    x: origin.x + local.x * c - local.y * s,
    y: origin.y + local.x * s + local.y * c
  };
};

/** 确定性线性同余随机数（mulberry32），保证演示可复现 */
export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }
  int(lo: number, hi: number): number {
    return Math.floor(this.range(lo, hi + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
}

/** 二维值噪声（哈希梯度），用于程序化地形 */
export class ValueNoise2D {
  private perm: Uint8Array;
  constructor(seed: number) {
    const rng = new Rng(seed);
    const p = new Uint8Array(512);
    const base = new Uint8Array(256);
    for (let i = 0; i < 256; i++) base[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = base[i];
      base[i] = base[j];
      base[j] = t;
    }
    for (let i = 0; i < 512; i++) p[i] = base[i & 255];
    this.perm = p;
  }

  private hash(ix: number, iy: number): number {
    return this.perm[(this.perm[ix & 255] + iy) & 255] / 255;
  }

  private static smooth(t: number): number {
    return t * t * (3 - 2 * t);
  }

  /** 返回 [0,1) 噪声值 */
  sample(x: number, y: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = ValueNoise2D.smooth(x - ix);
    const fy = ValueNoise2D.smooth(y - iy);
    const v00 = this.hash(ix, iy);
    const v10 = this.hash(ix + 1, iy);
    const v01 = this.hash(ix, iy + 1);
    const v11 = this.hash(ix + 1, iy + 1);
    const top = v00 + (v10 - v00) * fx;
    const bot = v01 + (v11 - v01) * fx;
    return top + (bot - top) * fy;
  }

  /** 多倍频叠加 */
  fbm(x: number, y: number, octaves = 3): number {
    let amp = 0.5;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += this.sample(x * freq, y * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }
}
