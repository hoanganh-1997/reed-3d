/**
 * Height map of the rock work (tank-local metres), so fish can stay clear of
 * rocks cheaply every frame. Built by ray-casting straight down once per rock
 * layout (and again when a rock model finishes loading). Overhangs count as
 * solid, which only means fish never squeeze under them.
 */
export class RockField {
  private nx: number;
  private nz: number;
  private h: Float32Array;

  constructor(private halfX: number, private halfZ: number, private cell: number, private floorY: number) {
    this.nx = Math.max(1, Math.ceil((2 * halfX) / cell));
    this.nz = Math.max(1, Math.ceil((2 * halfZ) / cell));
    this.h = new Float32Array(this.nx * this.nz).fill(floorY);
  }

  /** `sample(x, z)` returns the rock top under that point, or null for bare sand. */
  build(sample: (x: number, z: number) => number | null) {
    for (let i = 0; i < this.nx; i++) {
      const x = -this.halfX + (i + 0.5) * this.cell;
      for (let k = 0; k < this.nz; k++) {
        const z = -this.halfZ + (k + 0.5) * this.cell;
        const y = sample(x, z);
        this.h[i * this.nz + k] = y == null ? this.floorY : Math.max(this.floorY, y);
      }
    }
  }

  /** Highest ground (rock or sand) within `r` of (x, z). */
  heightNear(x: number, z: number, r: number) {
    const fi = (x + this.halfX) / this.cell - 0.5;
    const fk = (z + this.halfZ) / this.cell - 0.5;
    const span = r / this.cell;
    const i0 = Math.max(0, Math.floor(fi - span));
    const i1 = Math.min(this.nx - 1, Math.ceil(fi + span));
    const k0 = Math.max(0, Math.floor(fk - span));
    const k1 = Math.min(this.nz - 1, Math.ceil(fk + span));
    const span2 = (span + 0.75) * (span + 0.75);
    let best = this.floorY;
    for (let i = i0; i <= i1; i++) {
      const di = i - fi;
      for (let k = k0; k <= k1; k++) {
        const dk = k - fk;
        if (di * di + dk * dk > span2) continue;
        const v = this.h[i * this.nz + k];
        if (v > best) best = v;
      }
    }
    return best;
  }
}
