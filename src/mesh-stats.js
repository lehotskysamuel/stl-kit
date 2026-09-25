// Volume and surface area of a non-indexed triangle mesh (9 floats per triangle, as
// STLLoader produces), optionally scaled per axis first. Used by the worker at load time
// and by the main thread when a non-uniform scale changes the surface area.
//
// volume: sum of signed tetrahedra against a reference point (divergence theorem), so
//   it is only meaningful for a closed mesh; the sign is dropped so inverted normals
//   don't matter.
// closed: on a closed surface the triangle area vectors cancel out. If they don't (to
//   within 0.1 % of the total area), the mesh has holes and the volume is unreliable.
export function meshStats(position, sx = 1, sy = 1, sz = 1) {
  const n = position.length - (position.length % 9);
  if (n === 0) return { volume: 0, area: 0, closed: true };

  // Reference point on the mesh itself keeps the numbers small for models far from the origin.
  const ox = position[0] * sx;
  const oy = position[1] * sy;
  const oz = position[2] * sz;

  let volume = 0;
  let area = 0;
  let vx = 0;
  let vy = 0;
  let vz = 0;
  for (let i = 0; i < n; i += 9) {
    const ax = position[i] * sx - ox;
    const ay = position[i + 1] * sy - oy;
    const az = position[i + 2] * sz - oz;
    const bx = position[i + 3] * sx - ox;
    const by = position[i + 4] * sy - oy;
    const bz = position[i + 5] * sz - oz;
    const cx = position[i + 6] * sx - ox;
    const cy = position[i + 7] * sy - oy;
    const cz = position[i + 8] * sz - oz;

    // a · (b × c) = 6 × signed tetrahedron volume
    volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);

    // (b − a) × (c − a) = 2 × triangle area vector
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const wx = cx - ax;
    const wy = cy - ay;
    const wz = cz - az;
    const nx = uy * wz - uz * wy;
    const ny = uz * wx - ux * wz;
    const nz = ux * wy - uy * wx;
    area += Math.sqrt(nx * nx + ny * ny + nz * nz);
    vx += nx;
    vy += ny;
    vz += nz;
  }
  const openArea = Math.sqrt(vx * vx + vy * vy + vz * vz);
  return {
    volume: Math.abs(volume) / 6,
    area: area / 2,
    closed: openArea <= area * 1e-3,
  };
}
