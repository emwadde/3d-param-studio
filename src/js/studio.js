import { createBuilder } from './builder.js';
import { createColladaExporter } from './exporter-collada.js';

const modelId = new URLSearchParams(location.search).get('model');
const els = {
  title: document.getElementById('title'), subtitle: document.getElementById('subtitle'),
  controls: document.getElementById('controls'), err: document.getElementById('err'),
  info: document.getElementById('info'), exportBtn: document.getElementById('export'),
  stage: document.getElementById('stage'), canvas: document.getElementById('c'),
};

async function loadDoc() {
  if (!modelId) throw new Error('No ?model= given in the URL.');
  const res = await fetch(`/api/models/${encodeURIComponent(modelId)}`);
  if (!res.ok) throw new Error(res.status === 404 ? `No model named "${modelId}".` : `API returned ${res.status}`);
  return res.json();
}

async function main() {
  let doc;
  try { doc = await loadDoc(); }
  catch (e) { els.title.textContent = 'Could not load model'; els.err.textContent = e.message; return; }

  // math.js's browser build attaches itself as window.math; alias it the way the builder expects.
  const inst = createBuilder({ THREE: window.THREE, math: window.math }).build(doc);
  const { exportCollada } = createColladaExporter({ THREE: window.THREE });
  els.title.textContent = doc.meta.name;
  els.subtitle.textContent = 'Rendered by the parametric builder. Values in mm.';

  // --- render setup (same approach as the tested chair/wardrobe preview pages) ---
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas: els.canvas, antialias: true }); }
  catch (e) { els.stage.innerHTML = '<p style="padding:16px">WebGL is not available in this browser.</p>'; throw e; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 50, 20000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f94, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(1200, 2200, 1600);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -1400, right: 1400, top: 1400, bottom: -1400, near: 200, far: 6000 });
  scene.add(sun);
  scene.add(new THREE.DirectionalLight(0xffffff, 0.5).translateOnAxis(new THREE.Vector3(-1, -1, -1).normalize(), 1)); // soft fill so undersides aren't black
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.ShadowMaterial({ opacity: 0.25 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const grid = new THREE.GridHelper(3000, 30, 0x8a949c, 0x8a949c);
  grid.material.transparent = true; grid.material.opacity = 0.28; scene.add(grid);
  scene.add(inst.object);
  const tuneMeshes = () => inst.object.traverse((o) => { if (o.isMesh) o.castShadow = true; });

  const theme = () => renderer.setClearColor(getComputedStyle(document.body).backgroundColor);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { theme(); draw(); });

  // full-sphere orbit + pan (middle/right drag, Shift+drag, or the Pan tool), tested in the wardrobe preview
  const HOME = { theta: 0.55, phi: 1.15, r: 2200 };
  const st = { ...HOME }, target = new THREE.Vector3(0, 700, 0), homeTarget = target.clone();
  let tool = 'orbit';
  function place() {
    const s = Math.sin(st.phi);
    camera.position.set(target.x + st.r * s * Math.sin(st.theta), target.y + st.r * Math.cos(st.phi), target.z + st.r * s * Math.cos(st.theta));
    camera.lookAt(target);
  }
  let queued = false;
  function draw() { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; place(); renderer.render(scene, camera); }); }
  const clampR = (r) => Math.min(8000, Math.max(500, r));
  function pan(dx, dy) {
    const k = (2 * st.r * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / els.stage.clientHeight;
    place(); camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k).clampScalar(-3000, 3000);
  }
  const ptrs = new Map();
  const setCursor = () => { els.canvas.style.cursor = ptrs.size ? 'grabbing' : tool === 'pan' ? 'move' : 'grab'; };
  els.canvas.addEventListener('pointerdown', (e) => {
    els.canvas.setPointerCapture(e.pointerId);
    const mode = e.button === 1 || e.button === 2 || e.shiftKey || tool === 'pan' ? 'pan' : 'orbit';
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, mode }); setCursor();
    if (e.button === 1) e.preventDefault();
  });
  els.canvas.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  els.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  const endPtr = (e) => { ptrs.delete(e.pointerId); setCursor(); };
  els.canvas.addEventListener('pointerup', endPtr);
  els.canvas.addEventListener('pointercancel', endPtr);
  els.canvas.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (ptrs.size === 1) {
      if (p.mode === 'pan') pan(dx, dy);
      else { st.theta -= dx * 0.008; st.phi = Math.min(Math.PI - 0.02, Math.max(0.02, st.phi - dy * 0.008)); }
    } else if (ptrs.size === 2) {
      const o = [...ptrs.entries()].find(([id]) => id !== e.pointerId)[1];
      const d0 = Math.hypot(p.x - o.x, p.y - o.y), d1 = Math.hypot(e.clientX - o.x, e.clientY - o.y);
      if (d1 > 0) st.r = clampR(st.r * (d0 / d1));
      pan(dx / 2, dy / 2);
    }
    p.x = e.clientX; p.y = e.clientY; draw();
  });
  els.canvas.addEventListener('wheel', (e) => { e.preventDefault(); st.r = clampR(st.r * Math.exp(e.deltaY * 0.001)); draw(); }, { passive: false });
  document.querySelectorAll('#tools [data-tool]').forEach((b) => b.addEventListener('click', () => {
    tool = b.dataset.tool;
    document.querySelectorAll('#tools [data-tool]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    setCursor();
  }));
  document.getElementById('reset').addEventListener('click', () => { Object.assign(st, HOME); target.copy(homeTarget); draw(); });
  new ResizeObserver(() => {
    const w = els.stage.clientWidth, h = els.stage.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); draw();
  }).observe(els.stage);

  // --- generated parameter controls ---
  const words = (s) => s.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
  function updateParam(name, value, out) {
    try { inst.setParam(name, value); els.err.textContent = ''; if (out) out.textContent = value; tuneMeshes(); showInfo(); draw(); }
    catch (e) { els.err.textContent = e.message; }
  }
  function showInfo() { let n = 0; inst.object.traverse((o) => o.isMesh && n++); els.info.textContent = `${n} part${n === 1 ? '' : 's'} built`; }
  for (const [name, d] of Object.entries(inst.paramDefs)) {
    const row = document.createElement('div'); row.className = 'row';
    if (d.type === 'number') {
      row.innerHTML = `<label for="p-${name}">${words(name)}<output>${d.default}</output></label><input id="p-${name}" type="range" min="${d.min}" max="${d.max}" step="1" value="${d.default}">`;
      const input = row.querySelector('input'), out = row.querySelector('output');
      input.addEventListener('input', () => updateParam(name, +input.value, out));
    } else if (d.type === 'enum') {
      row.innerHTML = `<label for="p-${name}">${words(name)}</label><select id="p-${name}">${d.options.map((o) => `<option${o === d.default ? ' selected' : ''}>${o}</option>`).join('')}</select>`;
      row.querySelector('select').addEventListener('change', (e) => updateParam(name, e.target.value));
    } else {
      row.innerHTML = `<label class="check"><input type="checkbox" ${d.default ? 'checked' : ''}>${words(name)}</label>`;
      row.querySelector('input').addEventListener('change', (e) => updateParam(name, e.target.checked));
    }
    els.controls.appendChild(row);
  }

  // --- export ---
  els.exportBtn.disabled = false;
  els.exportBtn.addEventListener('click', () => {
    const xml = exportCollada(inst, { name: doc.meta.name });
    const blob = new Blob([xml], { type: 'model/vnd.collada+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${modelId}.dae`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  tuneMeshes(); showInfo(); theme(); draw();
}

main();
