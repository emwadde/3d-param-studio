// Parametric model builder (v0 draft).
// Usage: const b = createBuilder({ THREE, math }); const inst = b.build(doc);
//        scene.add(inst.object); inst.setParam('seatHeight', 500);
//
// Conventions:
//  - JSON number = literal, JSON string = mathjs formula (bare numbers are mm).
//  - Enum params are exposed to formulas as their option index, plus a lookup
//    object named after the param with a capital first letter (SeatMaterial.leather).
//  - Group `variables` are evaluated in order and cascade to all descendants.
//  - `visible` (element or group) false => the node is not built at all.
//  - `material`: if the string is a key in `materials` it is used literally,
//    otherwise it is evaluated as a formula that must return a material key.
//  - Rotation is in degrees. Unknown keys (e.g. "_comment") are ignored.
//  - `repeat: { count, as }` on an element or group builds `count` copies (integer 0..500); the loop
//    variable `as` (default "index", 0-based) is available to every formula in the copy. Copies are
//    named <name>1, <name>2, ... Avoid `i`, `e`, `pi` etc: mathjs treats them as constants.
//  - Extrude outline: a point list or { circle: {...} } (a round bar). Extrude holes: a point list, { circle: {x, y, radius, segments} } or { polygon: [[x, y], ...] };
//    the object forms accept `repeat` too. A hole outside the outline's bounding box throws.

export function createBuilder({ THREE, math }) {
  const compiled = new Map();
  const evalExpr = (expr, scope) => {
    let c = compiled.get(expr);
    if (!c) compiled.set(expr, (c = math.compile(expr)));
    let v = c.evaluate(scope);
    if (math.isUnit(v)) v = v.toNumber('mm');
    return typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v;
  };
  const val = (v, scope) => (typeof v === 'string' ? evalExpr(v, scope) : v);
  // n(value) evaluates in a scope; n.with({ k: v }) returns an evaluator with extra variables.
  const makeN = (scope) => { const n = (v) => val(v, scope); n.with = (vars) => makeN({ ...scope, ...vars }); return n; };
  const countOf = (n, rep, what) => {
    const c = n(rep.count);
    if (!Number.isInteger(c) || c < 0 || c > 500) throw new RangeError(`${what}: repeat count must be an integer from 0 to 500, got ${c}`);
    return c;
  };
  const copies = (n, entry, what, fn) =>
    entry.repeat ? Array.from({ length: countOf(n, entry.repeat, what) }, (_, k) => fn(n.with({ [entry.repeat.as ?? 'index']: k }))) : [fn(n)];
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  // Evaluate every formula string inside a geometry definition (skips "_comment" keys).
  const resolveDeep = (v, n) =>
    Array.isArray(v) ? v.map((x) => resolveDeep(x, n))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== '_comment').map(([k, x]) => [k, resolveDeep(x, n)]))
    : typeof v === 'string' ? n(v) : v;

  // Extrude geometry as explicit point lists. Circles become regular polygons (segments default 24)
  // with a vertex at angle 0.
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  const extrudeSpec = (g, n) => {
    const pt = (m) => ([x, y]) => [m(x), m(y)];
    const circle = (m, { x = 0, y = 0, radius, segments = 24 }) =>
      Array.from({ length: segments }, (_, i) => {
        const a = (2 * Math.PI * i) / segments;
        return [r4(m(x) + m(radius) * Math.cos(a)), r4(m(y) + m(radius) * Math.sin(a))];
      });
    const outline = Array.isArray(g.outline) ? g.outline.map(pt(n)) : circle(n, g.outline.circle); // point list or { circle }
    const holes = (g.holes || []).flatMap((h) =>
      Array.isArray(h) ? [h.map(pt(n))] : copies(n, h, 'hole', (m) => (h.circle ? circle(m, h.circle) : h.polygon.map(pt(m)))));
    const xs = outline.map((p) => p[0]), ys = outline.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    if (holes.some((h) => h.some(([x, y]) => x < x0 - 1e-6 || x > x1 + 1e-6 || y < y0 - 1e-6 || y > y1 + 1e-6)))
      throw new RangeError('Extrude: a hole lies outside the panel outline');
    return { outline, holes, depth: n(g.depth) };
  };
  const specs = { extrude: extrudeSpec }; // shapes whose resolved spec is not a plain deep-resolve

  // Shape registry: (geometryDef, n) => BufferGeometry, n evaluates a value in scope.
  const shapes = {
    box: (g, n) => new THREE.BoxGeometry(n(g.width), n(g.height), n(g.depth)),
    cylinder: (g, n) =>
      new THREE.CylinderGeometry(n(g.radiusTop), n(g.radiusBottom), n(g.height), g.radialSegments ?? 24),
    lathe: (g, n) =>
      new THREE.LatheGeometry(g.profile.map(([r, y]) => new THREE.Vector2(n(r), n(y))), g.segments ?? 24),
    extrude: (g, n) => {
      const s = extrudeSpec(g, n), v2 = ([x, y]) => new THREE.Vector2(x, y);
      const shape = new THREE.Shape(s.outline.map(v2));
      for (const h of s.holes) shape.holes.push(new THREE.Path(h.map(v2)));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: s.depth, bevelEnabled: false });
      geo.translate(0, 0, -s.depth / 2);
      return geo;
    },
  };

  function build(doc) {
    if (doc.unit && doc.unit !== 'mm') throw new Error(`Unsupported unit "${doc.unit}" (only mm for now)`);
    const defs = doc.parameters || {};
    const values = Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, d.default]));
    const holder = new THREE.Group();
    holder.name = doc.meta?.name ?? 'Model';

    const materials = new Map();
    const fallback = new THREE.MeshStandardMaterial({ color: '#999999' });
    const getMaterial = (key) => {
      if (key == null) return fallback;
      if (!materials.has(key)) {
        const m = (doc.materials || {})[key];
        if (!m) throw new Error(`Unknown material "${key}"`);
        const mat = new THREE.MeshStandardMaterial({ color: m.color, roughness: m.roughness ?? 0.8, metalness: m.metalness ?? 0 });
        if (m.map) mat.map = new THREE.TextureLoader().load(m.map); // browser only, untested
        materials.set(key, mat);
      }
      return materials.get(key);
    };

    const baseScope = () => {
      const s = {};
      for (const [k, d] of Object.entries(defs)) {
        if (d.type === 'enum') {
          s[k] = d.options.indexOf(values[k]);
          s[cap(k)] = Object.fromEntries(d.options.map((o, i) => [o, i]));
        } else s[k] = values[k];
      }
      return s;
    };

    function buildNode(node, parentScope, parent) {
      if (node.repeat) {
        const { repeat, ...rest } = node, total = countOf(makeN(parentScope), repeat, node.name ?? node.shape ?? 'node');
        for (let k = 0; k < total; k++) buildNode({ ...rest, name: `${node.name ?? node.shape}${k + 1}` }, { ...parentScope, [repeat.as ?? 'index']: k }, parent);
        return;
      }
      const scope = { ...parentScope };
      for (const [k, expr] of Object.entries(node.variables || {})) scope[k] = val(expr, scope);
      if (node.visible !== undefined && !val(node.visible, scope)) return;
      const n = makeN(scope);
      const t = node.transform || {}, p = t.position || {}, r = t.rotation || {};
      let obj;
      if (node.type === 'group') {
        obj = new THREE.Group();
        for (const child of node.children || []) buildNode(child, scope, obj);
      } else {
        const make = shapes[node.shape];
        if (!make) throw new Error(`Unknown shape "${node.shape}" on "${node.name}"`);
        const key = node.material == null ? null : (doc.materials || {})[node.material] ? node.material : n(node.material);
        obj = new THREE.Mesh(make(node.geometry, n), getMaterial(key));
        obj.userData.shape = node.shape;
        obj.userData.spec = { shape: node.shape, geometry: (specs[node.shape] || resolveDeep)(node.geometry, n), material: key }; // resolved values, for exporters
      }
      obj.name = node.name ?? node.shape ?? 'group';
      obj.position.set(n(p.x ?? 0), n(p.y ?? 0), n(p.z ?? 0));
      const rad = (d) => (n(d ?? 0) * Math.PI) / 180;
      obj.rotation.set(rad(r.x), rad(r.y), rad(r.z));
      parent.add(obj);
    }

    function rebuild() {
      holder.traverse((o) => o.geometry?.dispose());
      holder.clear();
      buildNode(doc.root, baseScope(), holder);
    }

    function setParams(changes) {
      const next = { ...values };
      for (const [k, v] of Object.entries(changes)) {
        const d = defs[k];
        if (!d) throw new Error(`Unknown parameter "${k}"`);
        if (d.type === 'number') {
          if (typeof v !== 'number' || v < (d.min ?? -Infinity) || v > (d.max ?? Infinity))
            throw new RangeError(`${k} must be a number in [${d.min ?? '-inf'}, ${d.max ?? 'inf'}], got ${v}`);
        } else if (d.type === 'enum') {
          if (!d.options.includes(v)) throw new RangeError(`${k} must be one of ${d.options.join(', ')}, got ${v}`);
        } else if (d.type === 'boolean' && typeof v !== 'boolean') throw new TypeError(`${k} must be boolean`);
        next[k] = v;
      }
      Object.assign(values, next);
      rebuild(); // v0: full re-evaluation; dependency-graph updates come later
    }

    rebuild();
    return {
      object: holder,
      doc,
      paramDefs: defs,
      getParams: () => ({ ...values }),
      setParam: (k, v) => setParams({ [k]: v }),
      setParams,
    };
  }

  return { build, registerShape: (name, fn) => (shapes[name] = fn) };
}
