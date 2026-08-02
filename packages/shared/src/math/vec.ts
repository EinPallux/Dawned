/** Minimal vector helpers for the shared simulation (no allocations on hot paths). */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const copyVec3 = (out: Vec3, src: Readonly<Vec3>): Vec3 => {
  out.x = src.x;
  out.y = src.y;
  out.z = src.z;
  return out;
};

export const lengthXZ = (x: number, z: number): number => Math.sqrt(x * x + z * z);

export const distanceXZ = (a: Readonly<Vec3>, b: Readonly<Vec3>): number =>
  lengthXZ(a.x - b.x, a.z - b.z);

export const distance = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Shortest signed angular difference from `a` to `b`, in radians (−π..π]. */
export const angleDelta = (a: number, b: number): number => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
};

/** Interpolate between two angles along the shortest arc. */
export const lerpAngle = (a: number, b: number, t: number): number => a + angleDelta(a, b) * t;

/** Normalize an angle into [0, 2π). */
export const normalizeAngle = (radians: number): number => {
  const twoPi = Math.PI * 2;
  const r = radians % twoPi;
  return r < 0 ? r + twoPi : r;
};
