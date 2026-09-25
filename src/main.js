import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { meshStats } from './mesh-stats.js';
import { KINDS, MATERIALS, defaultSettings, estimate, loadSettings, materialName, saveSettings } from './pricing.js';

// ---------------------------------------------------------------------------
// Scene setup (Z-up, like slicers / 3D printers: X = left-right, Y = front-back,
// Z = bottom-top; 1 unit = 1 mm)
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const viewportEl = $('viewport');
const canvas = $('canvas');
const listEl = $('object-list');
const emptyHint = $('empty-hint');
const dropOverlay = $('drop-overlay');
const loadingEl = $('loading');
const loadingText = $('loading-text');
const fileInput = $('file-input');
const bulkToggleBtn = $('bulk-toggle');
const bulkDeleteBtn = $('bulk-delete');
const bulkSaveBtn = $('bulk-save');
const openBtn = $('open-btn');
const toastEl = $('toast');
const spreadBtn = $('bulk-spread');
const centerBtn = $('center-scene');
const selCountEl = $('sel-count');
const resetViewBtn = $('reset-view');
const rotateBtns = { x: $('rot-x'), y: $('rot-y'), z: $('rot-z') };
const dialogBtns = { rotate: $('open-rotate'), move: $('open-move'), scale: $('open-scale') };
const costTotalEl = $('cost-total');
const costTotalTitle = $('cost-total-title');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x1e1f24);

// Overlay renderer for HTML dimension labels that track 3D positions.
const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = 'label-layer';
viewportEl.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();

const DEFAULT_CAMERA_POS = new THREE.Vector3(150, -150, 120);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
camera.up.set(0, 0, 1);
camera.position.copy(DEFAULT_CAMERA_POS);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.1;
controls.screenSpacePanning = false;

scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.2));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
keyLight.position.set(1, -1, 2);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
fillLight.position.set(-1, 1, 0.5);
scene.add(fillLight);

// Build plate grid on the XY plane (GridHelper is XZ by default -> rotate)
let grid = null;
function setGrid(size) {
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  }
  const divisions = Math.max(2, Math.round(size / 10));
  grid = new THREE.GridHelper(size, divisions, 0x55575f, 0x34353c);
  grid.rotation.x = Math.PI / 2;
  scene.add(grid);
}
setGrid(200);

scene.add(new THREE.AxesHelper(20));

function resize() {
  const { clientWidth: w, clientHeight: h } = viewportEl;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewportEl);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
});

// ---------------------------------------------------------------------------
// STL parsing in a Web Worker
// ---------------------------------------------------------------------------

const worker = new Worker(new URL('./stl-worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let nextRequestId = 1;

worker.onmessage = (e) => {
  const { id, error, ...result } = e.data;
  const req = pending.get(id);
  if (!req) return;
  pending.delete(id);
  if (error) req.reject(new Error(error));
  else req.resolve(result);
};

function workerRequest(message, transfer) {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...message }, transfer);
  });
}

const parseStl = (buffer) => workerRequest({ type: 'parse', buffer }, [buffer]);

// Binary STL of the object's geometry with its current transform baked in.
async function exportStl(obj) {
  obj.mesh.updateMatrixWorld(true);
  const position = obj.mesh.geometry.getAttribute('position').array.slice(); // copy: transferred
  const { buffer } = await workerRequest(
    { type: 'export', position, matrix: obj.mesh.matrixWorld.toArray() },
    [position.buffer],
  );
  return buffer;
}

// ---------------------------------------------------------------------------
// Object management
// ---------------------------------------------------------------------------

// { id, name, group, mesh, frame, bbox: Box3, size: Vector3, offset: Vector3, color, visible, stats }
// mesh.quaternion = orientation, mesh.scale = scale factors (1 = original file size),
// offset = where the footprint centre (x, y) and the bottom face (z) sit on the plate,
// stats = { volume, area, closed } of the geometry at the original file size.
const objects = [];
const selected = new Set(); // ids
let lastClickedId = null;
let nextId = 1;

const PALETTE = [0x4f8cff, 0xff8c4f, 0x5fd38a, 0xe06ad4, 0xf2d34f, 0x4fd6e6];

function formatMm(v) {
  return v.toFixed(v >= 100 ? 1 : 2);
}
function round2(v) {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

async function addStl(name, arrayBuffer, handle = null) {
  const { position, normal, stats } = await parseStl(arrayBuffer);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  if (normal) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  else geometry.computeVertexNormals();

  // Store the geometry centred on its own bounding box; placement is done by updateTransform.
  geometry.computeBoundingBox();
  const center = new THREE.Vector3();
  geometry.boundingBox.getCenter(center);
  geometry.translate(-center.x, -center.y, -center.z);
  geometry.computeBoundingBox();

  const color = PALETTE[objects.length % PALETTE.length];
  const material = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.05,
    roughness: 0.6,
    flatShading: true,
  });
  const mesh = new THREE.Mesh(geometry, material);

  // Group = mesh + bounding-box frame + dimension labels, so they show/hide together.
  const group = new THREE.Group();
  group.add(mesh);
  scene.add(group);

  const obj = {
    id: nextId++,
    name,
    group,
    mesh,
    frame: null,
    bbox: new THREE.Box3(),
    size: new THREE.Vector3(),
    offset: new THREE.Vector3(0, 0, 0),
    color,
    visible: true,
    handle, // FileSystemFileHandle when the browser gave us one (drop / native picker)
    savedState: null, // transform as it is in the file on disk
    stats,
    areaCache: null, // { key, area } for the last non-uniform scale, see objectStats
  };
  markSaved(obj);
  objects.push(obj);
  updateTransform(obj);
  selectOnly(obj.id);
  resetView();
  renderList();
  return obj;
}

function markSaved(obj) {
  obj.savedState = {
    quaternion: obj.mesh.quaternion.clone(),
    scale: obj.mesh.scale.clone(),
    offset: obj.offset.clone(),
  };
}

function isDirty(obj) {
  const s = obj.savedState;
  const eps = 1e-6;
  return (
    Math.abs(1 - Math.abs(obj.mesh.quaternion.dot(s.quaternion))) > eps ||
    obj.mesh.scale.distanceToSquared(s.scale) > eps ||
    obj.offset.distanceToSquared(s.offset) > eps
  );
}

function disposeSubtree(root) {
  root.traverse((child) => {
    if (child.isCSS2DObject) child.element.remove();
    child.geometry?.dispose();
    child.material?.dispose();
  });
}

function disposeObject(obj) {
  scene.remove(obj.group);
  disposeSubtree(obj.group);
}

// Re-place the mesh from its orientation/scale + plate offset (footprint centred on
// offset.xy, bottom face at offset.z), then recompute bounds, dimensions and frame.
function updateTransform(obj) {
  const { mesh } = obj;
  mesh.position.set(0, 0, 0);
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh, true); // precise: walks every vertex
  const center = new THREE.Vector3();
  box.getCenter(center);
  mesh.position.set(obj.offset.x - center.x, obj.offset.y - center.y, obj.offset.z - box.min.z);
  mesh.updateMatrixWorld(true);
  box.translate(mesh.position);

  obj.bbox = box;
  box.getSize(obj.size);

  if (obj.frame) {
    obj.group.remove(obj.frame);
    disposeSubtree(obj.frame);
  }
  obj.frame = buildDimensionBox(box, obj.size, obj.color);
  obj.group.add(obj.frame);
  renderList();
}

function removeObjects(ids) {
  const idSet = new Set(ids);
  for (let i = objects.length - 1; i >= 0; i--) {
    if (idSet.has(objects[i].id)) disposeObject(objects.splice(i, 1)[0]);
  }
  for (const id of idSet) selected.delete(id);
  if (!objects.some((o) => o.id === lastClickedId)) lastClickedId = null;
  applySelection();
  resetView();
  renderList();
}

function setVisible(ids, visible) {
  const idSet = new Set(ids);
  for (const o of objects) {
    if (!idSet.has(o.id)) continue;
    o.visible = visible;
    o.group.visible = visible;
  }
  renderList();
}

// --- selection ---------------------------------------------------------------

function applySelection() {
  for (const o of objects) {
    o.mesh.material.emissive.setHex(selected.has(o.id) ? 0x222a3a : 0x000000);
  }
}

function selectOnly(id) {
  selected.clear();
  selected.add(id);
  lastClickedId = id;
  applySelection();
}

function handleItemClick(obj, event) {
  const ids = objects.map((o) => o.id);
  if (event.shiftKey && lastClickedId != null && ids.includes(lastClickedId)) {
    const a = ids.indexOf(lastClickedId);
    const b = ids.indexOf(obj.id);
    if (!event.metaKey && !event.ctrlKey) selected.clear();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(ids[i]);
  } else if (event.metaKey || event.ctrlKey) {
    if (selected.has(obj.id)) selected.delete(obj.id);
    else selected.add(obj.id);
    lastClickedId = obj.id;
  } else {
    selected.clear();
    selected.add(obj.id);
    lastClickedId = obj.id;
  }
  applySelection();
  renderList();
}

function selectedObjects() {
  return objects.filter((o) => selected.has(o.id));
}

// --- bulk actions ------------------------------------------------------------

function deleteSelected() {
  if (!selected.size) return;
  removeObjects([...selected]);
}

// Hide if any selected object is visible, otherwise show all selected.
function toggleSelectedVisibility() {
  const sel = selectedObjects();
  if (!sel.length) return;
  const anyVisible = sel.some((o) => o.visible);
  setVisible(
    sel.map((o) => o.id),
    !anyVisible,
  );
}

// --- transforms ------------------------------------------------------------

const AXES = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

// Rotate the selected objects by `degrees` about a world axis.
function rotateSelected(axis, degrees = 90) {
  const sel = selectedObjects();
  if (!sel.length) return;
  const q = new THREE.Quaternion().setFromAxisAngle(AXES[axis], THREE.MathUtils.degToRad(degrees));
  for (const o of sel) {
    o.mesh.quaternion.premultiply(q);
    updateTransform(o);
  }
}

// Set an absolute orientation (Euler XYZ, degrees) on the given objects.
function setRotationDeg(ids, { x, y, z }) {
  for (const o of objects) {
    if (!ids.includes(o.id)) continue;
    o.mesh.rotation.set(
      THREE.MathUtils.degToRad(x),
      THREE.MathUtils.degToRad(y),
      THREE.MathUtils.degToRad(z),
      'XYZ',
    );
    updateTransform(o);
  }
}

function getRotationDeg(obj) {
  const e = obj.mesh.rotation;
  return {
    x: round2(THREE.MathUtils.radToDeg(e.x)),
    y: round2(THREE.MathUtils.radToDeg(e.y)),
    z: round2(THREE.MathUtils.radToDeg(e.z)),
  };
}

function setPosition(ids, { x, y, z }) {
  for (const o of objects) {
    if (!ids.includes(o.id)) continue;
    o.offset.set(x, y, z);
    updateTransform(o);
  }
}

// Scale factors relative to the original file size (1 = 100 %).
function setScale(ids, { x, y, z }) {
  if (!(x > 0 && y > 0 && z > 0)) return;
  for (const o of objects) {
    if (!ids.includes(o.id)) continue;
    o.mesh.scale.set(x, y, z);
    updateTransform(o);
  }
}

// Move the selected objects into a row to the right of everything else so nothing overlaps.
function spreadSelected() {
  const sel = selectedObjects();
  if (!sel.length) return;
  const rest = objects.filter((o) => !selected.has(o.id));
  const largest = Math.max(...objects.map((o) => Math.max(o.size.x, o.size.y)));
  const gap = Math.max(2, largest * 0.15);

  let cursor;
  if (rest.length) {
    cursor = Math.max(...rest.map((o) => o.bbox.max.x)) + gap;
  } else {
    const total = sel.reduce((acc, o) => acc + o.size.x, 0) + gap * (sel.length - 1);
    cursor = -total / 2;
  }
  for (const o of sel) {
    o.offset.x = cursor + o.size.x / 2;
    o.offset.y = 0;
    cursor += o.size.x + gap;
    updateTransform(o);
  }
  resetView();
}

// Shift every object (selected or not) by the same XY amount so the combined bounding
// box of the whole scene is centred on the plate. Relative positions are preserved.
function centerScene() {
  if (!objects.length) return;
  const box = new THREE.Box3();
  for (const o of objects) box.union(o.bbox);
  const center = new THREE.Vector3();
  box.getCenter(center);
  for (const o of objects) {
    o.offset.x -= center.x;
    o.offset.y -= center.y;
    updateTransform(o);
  }
  resetView();
}

// --- geometry helpers --------------------------------------------------------

// Wireframe box around the object's bounds with a size label on one edge per axis.
function buildDimensionBox(bbox, size, color) {
  const frame = new THREE.Group();
  const center = new THREE.Vector3();
  bbox.getCenter(center);

  const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z));
  const lines = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 }),
  );
  lines.position.copy(center);
  frame.add(lines);

  const { min, max } = bbox;
  const labels = [
    // X: front-bottom edge
    { axis: 'X', value: size.x, pos: [center.x, min.y, min.z] },
    // Y: right-bottom edge
    { axis: 'Y', value: size.y, pos: [max.x, center.y, min.z] },
    // Z: front-right vertical edge
    { axis: 'Z', value: size.z, pos: [max.x, min.y, center.z] },
  ];
  for (const { axis, value, pos } of labels) {
    const el = document.createElement('div');
    el.className = 'dim-label';
    el.innerHTML = `<span class="dim-axis">${axis}</span>${formatMm(value)} mm`;
    const label = new CSS2DObject(el);
    label.position.set(...pos);
    frame.add(label);
  }
  return frame;
}

// Frame all visible objects; with nothing visible, go back to the default view.
function resetView() {
  // Flush any orbit damping momentum so a reset right after a drag doesn't keep rotating.
  controls.enableDamping = false;
  controls.update();
  controls.enableDamping = true;

  const shown = objects.filter((o) => o.visible);
  if (!shown.length) {
    camera.position.copy(DEFAULT_CAMERA_POS);
    camera.near = 0.1;
    camera.far = 100000;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.update();
    setGrid(200);
    return;
  }
  const box = new THREE.Box3();
  for (const o of shown) box.expandByObject(o.mesh);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const fov = Math.min(vFov, hFov);
  const dist = (sphere.radius / Math.sin(fov / 2)) * 1.1;

  // Look from front-right-above (negative Y is "front" in slicer convention).
  const dir = new THREE.Vector3(1, -1, 0.8).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = Math.max(0.01, dist / 1000);
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();

  const plate = Math.max(size.x, size.y) * 1.5;
  setGrid(Math.ceil(plate / 50) * 50 || 200);
}

// ---------------------------------------------------------------------------
// Material cost
// ---------------------------------------------------------------------------

let pricing = loadSettings();
const KIND_LABELS = { fdm: 'FDM', resin: 'Resin' };

// Volume and surface area at the object's current scale. Rotation and position change
// neither; scale multiplies the volume by sx·sy·sz and, when uniform, the area by s².
// A non-uniform scale needs the area recomputed from the triangles (cached per scale).
function objectStats(obj) {
  const { x, y, z } = obj.mesh.scale;
  const { volume, area, closed } = obj.stats;
  const scaled = { volume: volume * Math.abs(x * y * z), area: area * x * x, closed };
  if (x !== y || y !== z) {
    const key = `${x},${y},${z}`;
    if (obj.areaCache?.key !== key) {
      const position = obj.mesh.geometry.getAttribute('position').array;
      obj.areaCache = { key, area: meshStats(position, x, y, z).area };
    }
    scaled.area = obj.areaCache.area;
  }
  return scaled;
}

// { fdm, resin } estimates for one object with the selected materials.
function objectCost(obj) {
  const stats = objectStats(obj);
  return Object.fromEntries(KINDS.map((kind) => [kind, estimate(kind, stats, pricing)]));
}

function sumEstimates(list) {
  const total = { ml: 0, mlMax: 0, grams: 0, gramsMax: 0, cost: 0, costMax: 0 };
  for (const e of list) for (const key in total) total[key] += e[key];
  return total;
}

function formatMoney(v) {
  return `${v.toFixed(2)} ${pricing.currency}`;
}
function formatAmount(v, unit) {
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${unit}`;
}

// Label over "0.42 € (max 0.61 €)"; grams (and ml for resin) in the tooltip.
function costCell(label, kind, e) {
  const cell = document.createElement('div');
  cell.className = 'cost-cell';
  const head = document.createElement('div');
  head.className = 'cost-kind';
  head.textContent = label;
  const value = document.createElement('span');
  value.className = 'cost-value';
  value.textContent = formatMoney(e.cost);
  const max = document.createElement('span');
  max.className = 'cost-max';
  max.textContent = `(max ${formatMoney(e.costMax)})`;
  cell.append(head, value, ' ', max);

  const material = materialName(kind, pricing[kind].material);
  const amount = (g, ml) => (kind === 'resin' ? `${formatAmount(g, 'g')} / ${formatAmount(ml, 'ml')}` : formatAmount(g, 'g'));
  cell.title =
    `${KIND_LABELS[kind]}, ${material}: about ${amount(e.grams, e.ml)}\n` +
    `Printed solid: ${amount(e.gramsMax, e.mlMax)}`;
  return cell;
}

function renderCostTotal(costs) {
  costTotalEl.innerHTML = '';
  costTotalEl.hidden = costs.length === 0;
  costTotalTitle.textContent = costs.length
    ? `Total, ${costs.length === 1 ? '1 object' : `all ${costs.length} objects`}`
    : 'Material cost';
  if (!costs.length) return;
  for (const kind of KINDS) {
    const label = `${KIND_LABELS[kind]} · ${materialName(kind, pricing[kind].material)}`;
    costTotalEl.appendChild(costCell(label, kind, sumEstimates(costs.map((c) => c[kind]))));
  }
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

const ICON_EYE =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_EYE_OFF =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.9 17.9A10.5 10.5 0 0 1 12 19c-6.5 0-10-7-10-7a17.6 17.6 0 0 1 4.1-4.9"/><path d="M9.9 5.2A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17.7 17.7 0 0 1-2.2 3"/><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="M2 2l20 20"/></svg>';

function renderList() {
  listEl.innerHTML = '';
  emptyHint.hidden = objects.length > 0;
  const costs = [];

  for (const o of objects) {
    const li = document.createElement('li');
    li.className =
      'object-item' + (selected.has(o.id) ? ' selected' : '') + (o.visible ? '' : ' hidden-object');
    li.dataset.id = o.id;

    const swatch = document.createElement('span');
    swatch.className = 'object-swatch';
    swatch.style.background = '#' + o.color.toString(16).padStart(6, '0');

    const meta = document.createElement('div');
    meta.className = 'object-meta';

    const nameEl = document.createElement('div');
    nameEl.className = 'object-name';
    nameEl.textContent = o.name;

    const dims = document.createElement('div');
    dims.className = 'object-dims';
    dims.title = 'width (X) × depth (Y) × height (Z)';
    dims.textContent = `${formatMm(o.size.x)} × ${formatMm(o.size.y)} × ${formatMm(o.size.z)} mm`;

    meta.append(nameEl, dims);
    if (!o.stats.closed) {
      const warn = document.createElement('div');
      warn.className = 'object-warn';
      warn.textContent = '⚠ Mesh has holes, cost is unreliable';
      warn.title =
        'The surface is not closed, so its volume cannot be measured reliably. ' +
        'Repairing the mesh (most slicers can) gives a correct estimate.';
      meta.appendChild(warn);
    }

    const cost = objectCost(o);
    costs.push(cost);
    const costRow = document.createElement('div');
    costRow.className = 'cost-grid';
    for (const kind of KINDS) costRow.appendChild(costCell(KIND_LABELS[kind], kind, cost[kind]));

    const eye = document.createElement('button');
    eye.className = 'object-btn object-eye';
    eye.title = o.visible ? 'Hide' : 'Show';
    eye.setAttribute('aria-pressed', String(o.visible));
    eye.innerHTML = o.visible ? ICON_EYE : ICON_EYE_OFF;
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      setVisible([o.id], !o.visible);
    });

    const remove = document.createElement('button');
    remove.className = 'object-btn object-remove';
    remove.title = 'Remove';
    remove.textContent = '×';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      removeObjects([o.id]);
    });

    li.append(swatch, meta, eye, remove, costRow);
    li.addEventListener('click', (e) => handleItemClick(o, e));
    listEl.appendChild(li);
  }
  renderCostTotal(costs);

  // Bulk toolbar state
  const sel = selectedObjects();
  const n = sel.length;
  const anyVisible = sel.some((o) => o.visible);
  const showMode = n > 0 && !anyVisible;
  bulkToggleBtn.querySelector('.icon-eye').hidden = showMode;
  bulkToggleBtn.querySelector('.icon-eye-off').hidden = !showMode;
  bulkToggleBtn.dataset.tip = (showMode ? 'Show' : 'Hide') + ' selected (Space)';
  bulkToggleBtn.setAttribute('aria-label', bulkToggleBtn.dataset.tip);
  selCountEl.textContent = n ? `${n} selected` : '';
  for (const b of [bulkToggleBtn, bulkDeleteBtn, spreadBtn, ...Object.values(rotateBtns), ...Object.values(dialogBtns)]) {
    b.disabled = n === 0;
  }
  bulkSaveBtn.disabled = n === 0 || !CAN_SAVE;
  centerBtn.disabled = objects.length === 0;
}

bulkDeleteBtn.addEventListener('click', deleteSelected);
bulkToggleBtn.addEventListener('click', toggleSelectedVisibility);
spreadBtn.addEventListener('click', spreadSelected);
centerBtn.addEventListener('click', centerScene);
for (const [axis, btn] of Object.entries(rotateBtns)) {
  btn.addEventListener('click', () => rotateSelected(axis, 90));
}
resetViewBtn.addEventListener('click', resetView);

// ---------------------------------------------------------------------------
// Transform dialogs (rotate / move / scale): live preview while editing, Apply
// keeps the result, Cancel / Escape restores the state from when the dialog opened.
// ---------------------------------------------------------------------------

function num(el, fallback = 0) {
  const v = parseFloat(el.value);
  return Number.isFinite(v) ? v : fallback;
}

function bindTransformDialog({ button, dialog, form, snapshot, onOpen, onPreview, restore }) {
  let targets = []; // [{ obj, snap }]

  button.addEventListener('click', () => {
    const sel = selectedObjects();
    if (!sel.length) return;
    targets = sel.map((obj) => ({ obj, snap: snapshot(obj) }));
    onOpen(targets);
    dialog.returnValue = '';
    dialog.showModal();
    form.querySelector('input[type="number"]')?.select();
  });

  const preview = () => targets.length && onPreview(targets);
  form.addEventListener('input', preview);
  form.addEventListener('change', preview);
  form.addEventListener('submit', () => {
    preview();
    targets = [];
  });
  form.querySelector('.dialog-cancel').addEventListener('click', () => dialog.close('cancel'));
  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'apply') {
      for (const t of targets) restore(t.obj, t.snap);
    }
    targets = [];
  });

  return { open: () => button.click() };
}

// --- rotate: absolute Euler XYZ in degrees, applied to every selected object ---
const rotateForm = $('rotate-form');
bindTransformDialog({
  button: dialogBtns.rotate,
  dialog: $('rotate-dialog'),
  form: rotateForm,
  snapshot: (o) => o.mesh.quaternion.clone(),
  onOpen: (targets) => {
    const first = targets[0].obj;
    const deg = getRotationDeg(first);
    rotateForm.elements.x.value = deg.x;
    rotateForm.elements.y.value = deg.y;
    rotateForm.elements.z.value = deg.z;
    $('rotate-hint').textContent =
      targets.length === 1
        ? `Rotation of ${first.name}, in degrees.`
        : `Rotation in degrees, applied to all ${targets.length} selected objects.`;
  },
  onPreview: (targets) => {
    setRotationDeg(
      targets.map((t) => t.obj.id),
      { x: num(rotateForm.elements.x), y: num(rotateForm.elements.y), z: num(rotateForm.elements.z) },
    );
  },
  restore: (o, snap) => {
    o.mesh.quaternion.copy(snap);
    updateTransform(o);
  },
});

// --- move: footprint centre X/Y and bottom height Z in mm; with several objects
// selected the fields show the first one and all of them move by the same delta ---
const moveForm = $('move-form');
bindTransformDialog({
  button: dialogBtns.move,
  dialog: $('move-dialog'),
  form: moveForm,
  snapshot: (o) => o.offset.clone(),
  onOpen: (targets) => {
    const first = targets[0];
    moveForm.elements.x.value = round2(first.snap.x);
    moveForm.elements.y.value = round2(first.snap.y);
    moveForm.elements.z.value = round2(first.snap.z);
    $('move-hint').textContent =
      targets.length === 1
        ? `Position of ${first.obj.name}: footprint centre (X, Y) and bottom face (Z), in mm.`
        : `Position of ${first.obj.name}; the other ${targets.length - 1} selected move along with it.`;
  },
  onPreview: (targets) => {
    const first = targets[0];
    const delta = new THREE.Vector3(
      num(moveForm.elements.x) - first.snap.x,
      num(moveForm.elements.y) - first.snap.y,
      num(moveForm.elements.z) - first.snap.z,
    );
    for (const t of targets) {
      const p = t.snap.clone().add(delta);
      setPosition([t.obj.id], p);
    }
  },
  restore: (o, snap) => {
    o.offset.copy(snap);
    updateTransform(o);
  },
});

// --- scale: percentages per axis, uniform by default, relative to the original
// file size or to the size at the moment the dialog was opened ---
const scaleForm = $('scale-form');
const scaleUniform = scaleForm.elements.uniform;
const scaleMode = scaleForm.elements.mode; // 'original' | 'current'
const scaleResult = $('scale-result');
let scaleTargets = [];

// Factor (relative to the original) that the current field values describe for a target.
function scaleFactorsFor(t) {
  const pct = { x: num(scaleForm.elements.x), y: num(scaleForm.elements.y), z: num(scaleForm.elements.z) };
  const rel = scaleMode.value === 'current';
  return {
    x: rel ? t.snap.x * (pct.x / 100) : pct.x / 100,
    y: rel ? t.snap.y * (pct.y / 100) : pct.y / 100,
    z: rel ? t.snap.z * (pct.z / 100) : pct.z / 100,
  };
}

function fillScaleFields(first) {
  // Express the first object's *current* scale in the selected mode.
  const s = first.obj.mesh.scale;
  const rel = scaleMode.value === 'current';
  scaleForm.elements.x.value = round2((rel ? s.x / first.snap.x : s.x) * 100);
  scaleForm.elements.y.value = round2((rel ? s.y / first.snap.y : s.y) * 100);
  scaleForm.elements.z.value = round2((rel ? s.z / first.snap.z : s.z) * 100);
}

function updateScaleResult(first) {
  const s = first.obj.size;
  scaleResult.textContent = `Result: ${formatMm(s.x)} × ${formatMm(s.y)} × ${formatMm(s.z)} mm`;
}

// Uniform: typing into one field mirrors it into the other two (before the form-level preview).
for (const axis of ['x', 'y', 'z']) {
  scaleForm.elements[axis].addEventListener('input', (e) => {
    if (!scaleUniform.checked) return;
    for (const other of ['x', 'y', 'z']) {
      if (other !== axis) scaleForm.elements[other].value = e.target.value;
    }
  });
}
scaleUniform.addEventListener('change', () => {
  if (scaleUniform.checked) {
    scaleForm.elements.y.value = scaleForm.elements.x.value;
    scaleForm.elements.z.value = scaleForm.elements.x.value;
  }
});
// Switching the reference keeps the previewed size; only the numbers are re-expressed.
scaleMode.addEventListener('change', () => {
  if (scaleTargets.length) fillScaleFields(scaleTargets[0]);
});

bindTransformDialog({
  button: dialogBtns.scale,
  dialog: $('scale-dialog'),
  form: scaleForm,
  snapshot: (o) => o.mesh.scale.clone(),
  onOpen: (targets) => {
    scaleTargets = targets;
    scaleUniform.checked = true;
    scaleMode.value = 'original';
    fillScaleFields(targets[0]);
    $('scale-hint').textContent =
      targets.length === 1
        ? `Scale of ${targets[0].obj.name}, in percent.`
        : `Scale in percent, applied to all ${targets.length} selected objects.`;
    updateScaleResult(targets[0]);
  },
  onPreview: (targets) => {
    for (const t of targets) setScale([t.obj.id], scaleFactorsFor(t));
    updateScaleResult(targets[0]);
  },
  restore: (o, snap) => {
    o.mesh.scale.copy(snap);
    updateTransform(o);
  },
});
$('scale-dialog').addEventListener('close', () => {
  scaleTargets = [];
});

// ---------------------------------------------------------------------------
// Save: overwrite the original files (File System Access API, Chromium only)
// ---------------------------------------------------------------------------

const CAN_SAVE = typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype;
if (!CAN_SAVE) {
  bulkSaveBtn.dataset.tip = 'Saving to the original file needs Chrome or Edge';
}

const saveDialog = $('save-dialog');
const saveForm = $('save-form');
const saveList = $('save-list');
const saveConfirmBtn = $('save-confirm');
let saveTargets = [];

function showToast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => (toastEl.hidden = true), 3000);
}

function openSaveDialog() {
  const sel = selectedObjects();
  if (!sel.length || !CAN_SAVE) return;
  saveTargets = sel.filter((o) => o.handle && isDirty(o));
  saveList.innerHTML = '';
  for (const o of sel) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'save-name';
    name.textContent = o.name;
    const status = document.createElement('span');
    status.className = 'save-status';
    if (!o.handle) {
      li.classList.add('skipped');
      status.textContent = 'no file access — skipped';
    } else if (!isDirty(o)) {
      li.classList.add('skipped');
      status.textContent = 'no changes — skipped';
    } else {
      status.textContent = 'will be overwritten';
    }
    li.append(name, status);
    saveList.appendChild(li);
  }
  const n = saveTargets.length;
  saveConfirmBtn.disabled = n === 0;
  saveConfirmBtn.textContent = n === 1 ? 'Overwrite 1 file' : `Overwrite ${n} files`;
  saveDialog.showModal();
}

async function saveTargetsToDisk() {
  const targets = saveTargets;
  saveTargets = [];
  if (!targets.length) return;

  // Ask for write permission on every file first, while we still have the click's
  // user activation (Chrome prompts once per file).
  const granted = [];
  for (const o of targets) {
    try {
      const perm = await o.handle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') granted.push(o);
    } catch (err) {
      console.error(err);
    }
  }
  if (!granted.length) {
    showToast('Save cancelled: no write permission');
    return;
  }

  loadingEl.hidden = false;
  let saved = 0;
  try {
    for (const o of granted) {
      loadingText.textContent = `Saving ${o.name}…`;
      const buffer = await exportStl(o);
      const writable = await o.handle.createWritable();
      await writable.write(buffer);
      await writable.close();
      markSaved(o);
      saved++;
    }
  } catch (err) {
    console.error(err);
    alert(`Could not save: ${err.message ?? err}`);
  } finally {
    loadingEl.hidden = true;
  }
  if (saved) showToast(saved === 1 ? `Saved ${granted[0].name}` : `Saved ${saved} files`);
}

bulkSaveBtn.addEventListener('click', openSaveDialog);
saveForm.querySelector('.dialog-cancel').addEventListener('click', () => saveDialog.close('cancel'));
saveForm.addEventListener('submit', () => {
  saveTargetsToDisk();
});
saveDialog.addEventListener('close', () => {
  if (saveDialog.returnValue !== 'save') saveTargets = [];
});

// ---------------------------------------------------------------------------
// Materials & prices dialog: the edits only take effect (and are stored) on Save
// ---------------------------------------------------------------------------

const pricingDialog = $('pricing-dialog');
const pricingForm = $('pricing-form');

// One row per preset: radio (the material the sidebar prices with), name, density, price.
for (const kind of KINDS) {
  const tbody = $(`${kind}-materials`);
  for (const m of MATERIALS[kind]) {
    const radioId = `${kind}-use-${m.id}`;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="radio" name="${kind}-material" value="${m.id}" id="${radioId}" /></td>
      <td><label for="${radioId}">${m.name}</label></td>
      <td><input name="${kind}-density-${m.id}" type="number" step="any" min="0.1" max="25" required aria-label="${m.name} density" /></td>
      <td><input name="${kind}-price-${m.id}" type="number" step="any" min="0" required aria-label="${m.name} price per kg" /></td>`;
    tbody.appendChild(tr);
  }
}

function updateCurrencyLabels() {
  const currency = pricingForm.elements.currency.value.trim() || pricing.currency;
  for (const el of pricingForm.querySelectorAll('.currency-label')) el.textContent = currency;
}

function fillPricingForm(settings) {
  const el = pricingForm.elements;
  el.currency.value = settings.currency;
  for (const kind of KINDS) {
    const cfg = settings[kind];
    el[`${kind}-material`].value = cfg.material;
    el[`${kind}-wall`].value = cfg.wall;
    el[`${kind}-extra`].value = cfg.extra;
    if ('infill' in cfg) el[`${kind}-infill`].value = cfg.infill;
    for (const [id, m] of Object.entries(cfg.materials)) {
      el[`${kind}-density-${id}`].value = m.density;
      el[`${kind}-price-${id}`].value = m.price;
    }
  }
  updateCurrencyLabels();
}

function readPricingForm() {
  const el = pricingForm.elements;
  const settings = defaultSettings();
  settings.currency = el.currency.value.trim() || settings.currency;
  for (const kind of KINDS) {
    const cfg = settings[kind];
    cfg.material = el[`${kind}-material`].value || cfg.material;
    cfg.wall = num(el[`${kind}-wall`], cfg.wall);
    cfg.extra = num(el[`${kind}-extra`], cfg.extra);
    if ('infill' in cfg) cfg.infill = num(el[`${kind}-infill`], cfg.infill);
    for (const [id, m] of Object.entries(cfg.materials)) {
      m.density = num(el[`${kind}-density-${id}`], m.density);
      m.price = num(el[`${kind}-price-${id}`], m.price);
    }
  }
  return settings;
}

$('open-pricing').addEventListener('click', () => {
  fillPricingForm(pricing);
  pricingDialog.returnValue = '';
  pricingDialog.showModal();
});
$('pricing-reset').addEventListener('click', () => fillPricingForm(defaultSettings()));
pricingForm.elements.currency.addEventListener('input', updateCurrencyLabels);
pricingForm.querySelector('.dialog-cancel').addEventListener('click', () => pricingDialog.close('cancel'));
pricingForm.addEventListener('submit', () => {
  pricing = readPricingForm();
  saveSettings(pricing);
  renderList();
});

// Buttons keep focus after a click; drop it so Space / Enter don't re-trigger them.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn && !btn.closest('dialog')) btn.blur();
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const key = e.code === 'Space' ? ' ' : e.key;
  switch (key) {
    case 'Delete':
      e.preventDefault();
      deleteSelected();
      break;
    case ' ':
      e.preventDefault();
      toggleSelectedVisibility();
      break;
    case 'Backspace':
      e.preventDefault();
      resetView();
      break;
    case 'Escape':
      selected.clear();
      applySelection();
      renderList();
      break;
    case 'a':
      // Select all (plain "a"; Cmd/Ctrl+A is left to the browser).
      for (const o of objects) selected.add(o.id);
      applySelection();
      renderList();
      break;
    default:
      return;
  }
});

// ---------------------------------------------------------------------------
// File loading (drag & drop + file picker)
// ---------------------------------------------------------------------------

// `entries`: Files, or { file, handle } pairs when the browser handed us a file handle.
async function loadFiles(entries) {
  const stl = [...entries]
    .map((e) => (e instanceof File ? { file: e, handle: null } : e))
    .filter((e) => e.file && /\.stl$/i.test(e.file.name));
  if (!stl.length) return;

  loadingEl.hidden = false;
  try {
    for (const { file, handle } of stl) {
      loadingText.textContent = `Loading ${file.name}…`;
      const buffer = await file.arrayBuffer();
      await addStl(file.name, buffer, handle);
    }
  } catch (err) {
    console.error(err);
    alert(`Could not load STL: ${err.message ?? err}`);
  } finally {
    loadingEl.hidden = true;
  }
}

fileInput.addEventListener('change', () => {
  loadFiles(fileInput.files);
  fileInput.value = '';
});

// Native picker gives writable handles (Chromium); otherwise fall back to <input type=file>.
openBtn.addEventListener('click', async () => {
  if (!window.showOpenFilePicker) {
    fileInput.click();
    return;
  }
  try {
    const handles = await window.showOpenFilePicker({
      multiple: true,
      types: [{ description: 'STL files', accept: { 'model/stl': ['.stl'] } }],
    });
    const entries = await Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle })));
    loadFiles(entries);
  } catch (err) {
    if (err?.name !== 'AbortError') console.error(err);
  }
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.hidden = true;
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  // getAsFile / getAsFileSystemHandle must be called synchronously inside the drop event.
  const items = [...e.dataTransfer.items].filter((i) => i.kind === 'file');
  const pendingEntries = items.map((i) => ({
    file: i.getAsFile(),
    handlePromise: i.getAsFileSystemHandle ? i.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null),
  }));
  Promise.all(
    pendingEntries.map(async ({ file, handlePromise }) => {
      const handle = await handlePromise;
      return { file, handle: handle && handle.kind === 'file' ? handle : null };
    }),
  ).then(loadFiles);
});

// Expose for debugging / testing in the console.
window.stlKit = {
  addStl,
  loadFiles,
  removeObjects,
  setVisible,
  resetView,
  rotateSelected,
  setRotationDeg,
  getRotationDeg,
  setPosition,
  setScale,
  spreadSelected,
  centerScene,
  deleteSelected,
  exportStl,
  isDirty,
  markSaved,
  openSaveDialog,
  toggleSelectedVisibility,
  objectStats,
  objectCost,
  objects,
  selected,
};
