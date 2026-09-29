// Collada (.dae) exporter for the parametric builder (v0 draft).
// Works from the resolved shape definitions on each mesh (mesh.userData.spec), not from Three.js
// triangles, so panels are written as real faces: box sides are single 4-vertex faces, and the
// walls of an extruded panel (outline and holes) are single 4-vertex faces too.
//
//  - Supported shapes: "box" and "extrude" (with holes). Anything else throws instead of silently
//    triangulating.
//  - Extrude end caps are triangulated (SketchUp's "Merge Coplanar Faces" import option, on by
//    default, merges them back into one face with the hole). <ph>/<h> polygon holes are avoided
//    because other importers are known to drop faces with holes and SketchUp's support is unverified.
//  - One unique geometry + one node per panel (never shared), so per-panel edits in SketchUp
//    (e.g. coloring edges for banding) can't leak onto another panel.
//  - Group hierarchy is flattened: each node carries the panel's world transform.
//  - Panels sit inside a named wrapper node inside a root node called "SketchUp", mirroring the
//    structure of SketchUp's own export (SketchUp > group > panels). Panels placed directly under
//    the scene were merged into loose geometry by SketchUp's importer.
//  - Each panel's geometry starts at its own minimum corner (origin at a corner, not the center).
//  - No normals are written, so the importer has nothing to "smooth" with.
//  - Default output is Z-up with the unit set to millimeters (SketchUp convention: front = -Y).

export function createColladaExporter({ THREE }) {
  // Box corners (0..1) and faces wound counter-clockwise seen from outside (right-handed axes).
  const CORNERS = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
  const FACES = [[0,3,2,1], [4,5,6,7], [0,1,5,4], [2,3,7,6], [0,4,7,3], [1,2,6,5]];

  const fmt = (n) => { const r = Math.round(n * 1e4) / 1e4; return String(Object.is(r, -0) ? 0 : r); };
  const fmtM = (n) => { const r = +n.toFixed(9); return String(Object.is(r, -0) ? 0 : r); }; // node matrices keep full precision so rotations stay orthonormal
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const idOf = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

  // Each builder returns { verts: [[x,y,z]] in the shape's local (Three.js) axes, faces: [[vertex indices]] }.
  const boxMesh = ({ width: w, height: h, depth: d }) => ({
    verts: CORNERS.map(([x, y, z]) => [(x - 0.5) * w, (y - 0.5) * h, (z - 0.5) * d]),
    faces: FACES,
  });

  // Outline in local xy, extruded along z (centered). Outer loop CCW, holes CW seen from +z.
  function extrudeMesh({ outline, holes, depth }) {
    const area = (p) => p.reduce((s, [x, y], i) => { const [x2, y2] = p[(i + 1) % p.length]; return s + (x * y2 - x2 * y) / 2; }, 0);
    const loops = [area(outline) > 0 ? outline : [...outline].reverse(), ...holes.map((h) => (area(h) < 0 ? h : [...h].reverse()))];
    const hz = depth / 2, verts = [], start = [], faces = [];
    for (const L of loops) { start.push(verts.length); for (const [x, y] of L) verts.push([x, y, -hz], [x, y, hz]); }
    // walls: one quad per loop edge, outward (away from the material) for the outer loop and the holes
    loops.forEach((L, l) => L.forEach((_, i) => {
      const a = start[l] + 2 * i, b = start[l] + 2 * ((i + 1) % L.length);
      faces.push([a, b, b + 1, a + 1]);
    }));
    // end caps: triangulate the outline with its holes; vertex k of the flat point list is verts 2k (z-) / 2k+1 (z+)
    const v2 = (p) => new THREE.Vector2(p[0], p[1]);
    const flat = loops.flat();
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(loops[0].map(v2), loops.slice(1).map((h) => h.map(v2)))) {
      const [a, b, c] = area([flat[i], flat[j], flat[k]]) > 0 ? [i, j, k] : [i, k, j]; // CCW seen from +z
      faces.push([2 * a + 1, 2 * b + 1, 2 * c + 1]); // +z cap
      faces.push([2 * a, 2 * c, 2 * b]);             // -z cap (reversed)
    }
    return { verts, faces };
  }

  function exportCollada(instance, { upAxis = 'Z_UP', name = instance.object.name, created = new Date().toISOString() } = {}) {
    const zUp = upAxis === 'Z_UP';
    // Three.js is Y-up (front = +z). Z-up: (x, y, z) -> (x, -z, y).
    const C = zUp ? new THREE.Matrix4().set(1,0,0,0, 0,0,-1,0, 0,1,0,0, 0,0,0,1) : new THREE.Matrix4();
    const Cinv = C.clone().invert();

    instance.object.updateMatrixWorld(true);
    const panels = [];
    instance.object.traverse((o) => { if (o.isMesh) panels.push(o); });

    const used = new Set(), materialKeys = new Set();
    let geometries = '', nodes = '';
    for (const mesh of panels) {
      const spec = mesh.userData.spec;
      const build = { box: boxMesh, extrude: extrudeMesh }[spec?.shape];
      if (!build) throw new Error(`Collada export: "${mesh.name}" has shape "${spec?.shape}"; only "box" and "extrude" are supported so far`);
      let base = idOf(mesh.name), id = base;
      for (let i = 2; used.has(id); i++) id = `${base}_${i}`;
      used.add(id);

      const { verts, faces } = build(spec.geometry);
      const v3 = verts.map((v) => new THREE.Vector3(...v).applyMatrix4(C));
      const min = v3.reduce((m, v) => m.min(v), new THREE.Vector3(Infinity, Infinity, Infinity));
      const pos = v3.flatMap((v) => [v.x - min.x, v.y - min.y, v.z - min.z]); // geometry starts at its min corner

      const M = new THREE.Matrix4().multiplyMatrices(C, mesh.matrixWorld).multiply(Cinv).multiply(new THREE.Matrix4().makeTranslation(min.x, min.y, min.z));
      const rows = M.clone().transpose().elements; // Collada matrices are row-major

      const slot = spec.material ? `${idOf(spec.material)}-slot` : null;
      if (spec.material) materialKeys.add(spec.material);

      geometries += `
    <geometry id="geo-${id}" name="${esc(mesh.name)}">
      <mesh>
        <source id="geo-${id}-pos">
          <float_array id="geo-${id}-pos-array" count="${pos.length}">${pos.map(fmt).join(' ')}</float_array>
          <technique_common><accessor source="#geo-${id}-pos-array" count="${verts.length}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common>
        </source>
        <vertices id="geo-${id}-vtx"><input semantic="POSITION" source="#geo-${id}-pos"/></vertices>
        <polylist${slot ? ` material="${slot}"` : ''} count="${faces.length}">
          <input semantic="VERTEX" source="#geo-${id}-vtx" offset="0"/>
          <vcount>${faces.map((f) => f.length).join(' ')}</vcount>
          <p>${faces.flat().join(' ')}</p>
        </polylist>
      </mesh>
    </geometry>`;
      nodes += `
      <node id="node-${id}" name="${esc(mesh.name)}" type="NODE">
        <matrix sid="transform">${Array.from(rows).map(fmtM).join(' ')}</matrix>
        <instance_geometry url="#geo-${id}">${slot ? `
          <bind_material><technique_common><instance_material symbol="${slot}" target="#mat-${idOf(spec.material)}"/></technique_common></bind_material>` : ''}
        </instance_geometry>
      </node>`;
    }

    let effects = '', mats = '';
    for (const key of materialKeys) {
      const m = instance.doc.materials?.[key];
      if (!m) continue;
      const [r, g, b] = rgb(m.color);
      effects += `\n    <effect id="fx-${idOf(key)}"><profile_COMMON><technique sid="common"><phong><diffuse><color>${fmt(r)} ${fmt(g)} ${fmt(b)} 1</color></diffuse></phong></technique></profile_COMMON></effect>`;
      mats += `\n    <material id="mat-${idOf(key)}" name="${esc(key)}"><instance_effect url="#fx-${idOf(key)}"/></material>`;
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset>
    <contributor><authoring_tool>parametric-builder (draft)</authoring_tool></contributor>
    <created>${created}</created>
    <modified>${created}</modified>
    <unit name="millimeter" meter="0.001"/>
    <up_axis>${upAxis}</up_axis>
  </asset>
  <library_effects>${effects}
  </library_effects>
  <library_materials>${mats}
  </library_materials>
  <library_geometries>${geometries}
  </library_geometries>
  <library_visual_scenes>
    <visual_scene id="scene" name="${esc(name)}">
      <node name="SketchUp">
        <node id="node-model" name="${esc(name)}">
          <matrix sid="transform">1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1</matrix>${nodes}
        </node>
      </node>
    </visual_scene>
  </library_visual_scenes>
  <scene><instance_visual_scene url="#scene"/></scene>
</COLLADA>
`;
  }

  return { exportCollada };
}
