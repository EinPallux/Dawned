/**
 * How big is a baked model, in metres, as the game will draw it?
 *
 * Not the same question as "how big are its vertices". A glTF node carries a
 * transform, so a mesh whose POSITION accessors span 0.4 units can render at a
 * metre — and the naive check (read the accessor min/max) reports the 0.4 and
 * looks authoritative. That measurement said the Medieval Village bonfire was
 * 41 cm across when it is 1.02 m, and said the KayKit shrine was ONE CENTIMETRE
 * when it is 2.4 m tall. Both readings were wrong in the same way, which is what
 * makes this worth a module instead of a comment.
 *
 * The world is metric and placements carry no scale (see `scaleDocument` in
 * build.mjs), so a pack authored in non-metre units is corrected once at bake
 * time — and this is how anyone checks that the correction landed.
 */

/** Compose a node's TRS into a column-major 4×4. */
const localMatrix = (node) => {
  const [tx, ty, tz] = node.getTranslation();
  const [qx, qy, qz, qw] = node.getRotation();
  const [sx, sy, sz] = node.getScale();
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
};

const multiply = (a, b) => {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
    }
  }
  return out;
};

const transformPoint = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * World-space bounding box of every mesh in the document's scenes.
 *
 * All EIGHT corners of each primitive's local box are transformed, not just the
 * min and max: a node rotated 90° swaps axes, and transforming two opposite
 * corners of an axis-aligned box gives a box that is no longer axis-aligned —
 * which silently under-reports the height of anything the pack laid on its side.
 *
 * Returns `{ size: [x, y, z], min, max }` in metres, or null if there is no
 * geometry at all (an animation-only library, for instance).
 */
export const worldSpaceBounds = (document) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let sawGeometry = false;

  const walk = (node, parentMatrix) => {
    const world = multiply(parentMatrix, localMatrix(node));
    const mesh = node.getMesh();
    if (mesh) {
      for (const primitive of mesh.listPrimitives()) {
        const position = primitive.getAttribute('POSITION');
        if (!position) continue;
        const lo = position.getMin([]);
        const hi = position.getMax([]);
        sawGeometry = true;
        for (let corner = 0; corner < 8; corner++) {
          const point = transformPoint(world, [
            corner & 1 ? hi[0] : lo[0],
            corner & 2 ? hi[1] : lo[1],
            corner & 4 ? hi[2] : lo[2],
          ]);
          for (let axis = 0; axis < 3; axis++) {
            min[axis] = Math.min(min[axis], point[axis]);
            max[axis] = Math.max(max[axis], point[axis]);
          }
        }
      }
    }
    for (const child of node.listChildren()) walk(child, world);
  };

  for (const scene of document.getRoot().listScenes()) {
    for (const node of scene.listChildren()) walk(node, IDENTITY);
  }
  if (!sawGeometry) return null;
  return { size: max.map((value, axis) => value - min[axis]), min, max };
};
