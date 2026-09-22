// Parses and serialises STL files off the main thread so the UI stays responsive.
import { Matrix4, Vector3 } from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

const loader = new STLLoader();

function parse(buffer) {
  const geometry = loader.parse(buffer);
  const position = geometry.getAttribute('position').array;
  const normal = geometry.getAttribute('normal')?.array ?? null;
  const transfer = [position.buffer];
  if (normal) transfer.push(normal.buffer);
  return { result: { position, normal }, transfer };
}

// Binary STL with the given matrix baked into every vertex; face normals recomputed.
function exportBinary(position, matrixArray) {
  const m = new Matrix4().fromArray(matrixArray);
  const triangles = position.length / 9;
  const buffer = new ArrayBuffer(84 + triangles * 50);
  const dv = new DataView(buffer);
  const header = 'Binary STL written by STL Kit';
  for (let i = 0; i < header.length && i < 80; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, triangles, true);

  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const cb = new Vector3();
  const ab = new Vector3();
  const n = new Vector3();
  let off = 84;
  for (let i = 0; i < triangles; i++) {
    a.fromArray(position, i * 9).applyMatrix4(m);
    b.fromArray(position, i * 9 + 3).applyMatrix4(m);
    c.fromArray(position, i * 9 + 6).applyMatrix4(m);
    cb.subVectors(c, b);
    ab.subVectors(a, b);
    n.crossVectors(cb, ab).normalize();
    dv.setFloat32(off, n.x, true);
    dv.setFloat32(off + 4, n.y, true);
    dv.setFloat32(off + 8, n.z, true);
    for (const [k, v] of [a, b, c].entries()) {
      dv.setFloat32(off + 12 + k * 12, v.x, true);
      dv.setFloat32(off + 16 + k * 12, v.y, true);
      dv.setFloat32(off + 20 + k * 12, v.z, true);
    }
    dv.setUint16(off + 48, 0, true);
    off += 50;
  }
  return { result: { buffer }, transfer: [buffer] };
}

self.onmessage = (e) => {
  const { id, type } = e.data;
  try {
    const { result, transfer } =
      type === 'export' ? exportBinary(e.data.position, e.data.matrix) : parse(e.data.buffer);
    self.postMessage({ id, ...result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: err?.message ?? String(err) });
  }
};
