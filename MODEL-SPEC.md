# Model Spec

This document specifies the JSON format used by `src/js/builder.js` (renders a model
and lets its parameters change live) and `src/js/exporter-collada.js` (writes a model
to a SketchUp-ready `.dae` file). It is written so that a human, or a different AI
agent with no other context, can author a new model file correctly.

If you are an agent authoring a model: read the whole document before writing JSON,
then read **§9 Authoring checklist** again right before you start, and validate your
file against **§10 Common mistakes** before calling it done.

Status: v0. This format has been tested against SketchUp import for boxes, extruded
panels with holes, repeated elements, repeated holes, and rotated (hinged) parts, but
it is still evolving — see **§8 Known limitations**.

---

## 1. File shape

```jsonc
{
  "_comment": "optional, anywhere, ignored by the builder",
  "schemaVersion": "1.0",
  "unit": "mm",                    // required to be exactly "mm" — see §2
  "meta": { "id": "unique-id", "name": "Display Name" },

  "parameters": { /* §3 */ },
  "materials":  { /* §6 */ },
  "root": { /* §4/§5, a "group" node */ }
}
```

- `meta.id` must be unique across the model catalogue (used in URLs and by the API to
  look the file up) and should be a lowercase, hyphenated slug (`wardrobe-3-door`, not
  `Wardrobe 3 Door`).
- `meta.name` is the human-readable display name.
- `root` is always a **group** node (§5), the top of the scene.
- A key literally named `_comment` is allowed on any object in the file — inside
  `geometry`, on a node, anywhere — and is always ignored. Use it freely to document
  a model in place. It is not evaluated, not a formula, and does not need to be valid
  JSON beyond being a string.

## 2. Values: literal vs. formula, and units

**A JSON number is always a literal. A JSON string is always a formula**, evaluated by
[mathjs](https://mathjs.org)'s expression parser. There is no third form and no
`{ value, formula }` wrapper — this rule applies uniformly to every numeric field in
the file (transform positions, geometry dimensions, hole radii, repeat counts,
everything).

```jsonc
"width": 800            // literal: exactly 800
"width": "800"          // formula that evaluates to 800 — same result, more typing
"width": "innerWidth"   // formula: looks up the variable innerWidth in scope
"width": "deskWidth / 2 - thickness"   // formula: full expression
```

The document unit is **millimeters**, and only `"unit": "mm"` is accepted — the
builder throws on any other value. A **bare number in a formula is mm**; mathjs also
understands explicit unit suffixes (`"500 mm + 2 cm"` evaluates to `520 mm`), and the
builder converts any mathjs `Unit` result back to a plain number in mm before using it.
There is no way to set a different default unit per-document or per-value — if you
write `"25"` you get 25 mm, not 25 of some other unit.

Every evaluated number is rounded to 4 decimal places (0.0001 mm) to avoid floating
point noise compounding through chains of formulas.

## 3. Parameters

`parameters` is an object of `name -> definition`. Each name becomes a variable
available to every formula in the file (see §5's scope rules for how). Three types:

```jsonc
"width":        { "type": "number",  "default": 800, "min": 300, "max": 2400 },
"hasBackrest":  { "type": "boolean", "default": true },
"seatMaterial": { "type": "enum",    "default": "fabric", "options": ["fabric", "leather"] }
```

- **`number`**: `default`, `min`, `max` are all required in practice (the builder
  allows omitting min/max, which then default to ±Infinity, but always set real
  bounds — they are what the UI uses to build a slider, and what protects the model
  from nonsensical values).
- **`boolean`**: just `default`.
- **`enum`**: `options` is an ordered list of strings; `default` must be one of them.

### Enum values in formulas

An enum parameter's **name** resolves in formulas to the **0-based index** of its
current option in `options` — not the string. mathjs cannot compare two strings for
equality (`"left" == "left"` throws — this is a real, long-standing mathjs limitation,
not a bug in this builder), so enums are numeric under the hood.

To keep formulas readable anyway, the builder also injects a **lookup object** named
after the parameter with its first letter capitalized, mapping each option string to
its index:

```jsonc
"grommetPosition": { "type": "enum", "default": "center", "options": ["left", "center", "right"] }
```

```
grommetPosition                       // 0, 1, or 2 depending on the current selection
GrommetPosition.left                  // always 0
GrommetPosition.right                 // always 2
grommetPosition == GrommetPosition.right ? deskWidth - edgeMargin : edgeMargin
```

Always write comparisons against the `Cap(Name).option` form, never a bare number —
it documents itself and survives someone reordering `options` later (though reordering
still changes the underlying index values, so avoid that once a model is in use).

## 4. Node types

Every entry in a `children` array, and `root` itself, is a **node**: either a
**group** (`"type": "group"`) or an **element** (`"type": "element"`). Both share:

| field | meaning |
|---|---|
| `name` | Required in practice — becomes the Three.js object name and, for elements reaching the exporter, the SketchUp component/group name and cutlist row name. |
| `transform.position` | `{ x, y, z }`, each a literal or formula. Any axis omitted defaults to 0. |
| `transform.rotation` | `{ x, y, z }`, **degrees**, each a literal or formula. Any axis omitted defaults to 0. Applied in Three.js's default XYZ order. |
| `visible` | Optional literal `true`/`false` or a formula. If it evaluates falsy, **the whole node — and everything inside it if it's a group — is skipped entirely**: no geometry built, no children evaluated, nothing added to the scene. |
| `variables` | Group nodes only — see §5. |
| `repeat` | See §5.3. |
| `_comment` | Ignored, as always. |

A group's children are ordinary siblings in the output; the group itself is never a
visible object, it only establishes position/rotation/variables that its children
inherit.

## 5. Groups

```jsonc
{
  "type": "group",
  "name": "Legs",
  "variables": { "legHeight": "seatHeight - seatThickness" },
  "children": [ /* nodes */ ]
}
```

### 5.1 Variables and scope cascading

`variables` is an object of `name -> formula`, evaluated **in the order they're
written**, top to bottom — a later variable in the same object can reference an
earlier one, but not vice versa. Once evaluated, every variable becomes part of the
scope available to:

- that group's own `transform`/`visible` formulas,
- every formula in every descendant, arbitrarily deep, unless shadowed,
- but **not** to sibling groups or anything outside this group's subtree.

This is ordinary nested lexical scoping: a child can always see everything an
ancestor defined, and can define a variable with the same name as an ancestor's to
shadow it for itself and its own descendants — the ancestor's value is unaffected and
still visible to the ancestor's other children.

The scope always starts, at the document root, with every parameter (by its own name)
plus every enum parameter's capitalized lookup object (§3).

### 5.2 Groups are not rendered

A group node itself produces no geometry and is never a mesh. It exists purely to
establish a coordinate frame (via its own `transform`) and a set of `variables` for
its children. Position an element directly if you don't need shared variables or a
shared transform — wrapping every single element in its own group is unnecessary.

### 5.3 `repeat`

Either a group or an element can carry `repeat` to build multiple copies:

```jsonc
{
  "type": "element", "shape": "box", "name": "Shelf",
  "repeat": { "count": "shelfCount", "as": "shelfIndex" },
  "transform": { "position": { "y": "shelfIndex * shelfGap" } },
  "geometry": { "width": "innerWidth", "height": "thickness", "depth": "depth" }
}
```

- `count` is a literal or formula that **must evaluate to an integer from 0 to 500**;
  anything else throws (a non-integer, a negative number, or over 500).
- `as` names the loop variable (default `"index"`), available — as a plain 0-based
  integer — to every formula belonging to that specific copy, cascading to its own
  children the same way group variables do.
- Copies are named `<name>1`, `<name>2`, … (1-based, unrelated to the 0-based loop
  variable). A repeated node's own `name` field is what gets numbered.
- `count: 0` builds nothing, silently — a valid way to make an optional repeated
  feature disappear entirely, no `visible` needed.
- **Do not name the loop variable (or any parameter) after a mathjs constant** — see
  §10.

`repeat` also works inside an extrude's `holes` array, for patterns like a column of
shelf-pin holes — see §7.4.

## 6. Materials

```jsonc
"materials": {
  "fabric":  { "color": "#7a6a58", "roughness": 0.9 },
  "leather": { "color": "#4a2c1c", "roughness": 0.3, "metalness": 0.1 }
}
```

`color` is required (hex string). `roughness` defaults to 0.8, `metalness` to 0 if
omitted. An optional `map` (texture URL) is accepted by the builder but is
**untested** — it only works in a real browser (uses `THREE.TextureLoader`) and has
never been exercised end to end; don't rely on it yet.

An element's `material` field is a **key into this object**, but with one piece of
implicit behavior: **if the string exactly matches a key in `materials`, it's used
literally; otherwise it's evaluated as a formula that must itself return a matching
key.** This lets you either hardcode a material or select one dynamically:

```jsonc
"material": "wood"                                                    // literal
"material": "seatMaterial == SeatMaterial.leather ? \"leather\" : \"fabric\""  // formula
```

This dual behavior is a known rough edge — see §8. If you want a formula whose
variable name happens to collide with a literal material key, it will be treated as
literal, not evaluated; avoid that collision.

An element with no `material` field renders in a flat gray fallback color in the
browser preview. It still exports to Collada — the `.dae` file just won't assign any
material to that panel, and SketchUp will show it untextured. Verified directly: an
element with no `material` field exports without error, its `<polylist>` simply
carries no `material` attribute. Still, set a real `material` on anything meant to
leave the browser, so it isn't untextured by accident in SketchUp.

## 7. Shapes

Every element has a `"shape"` naming which geometry builder to use, and a `geometry`
object whose fields depend on the shape. Four shapes exist today; **only `box` and
`extrude` can be exported to Collada** (§7.5, §8) — `cylinder` and `lathe` render and
preview fine but currently throw a clear error if you try to export them.

### 7.1 `box`

```jsonc
"geometry": { "width": "deskWidth", "height": "topThickness", "depth": "deskDepth" }
```

A rectangular panel, centered on its own local origin (i.e. its position in
`transform.position` is its center, not a corner). Exactly the shape used for every
flat panel in the tested carcass, shelving, and wardrobe models.

### 7.2 `cylinder`

```jsonc
"geometry": { "radiusTop": 22, "radiusBottom": 14, "height": "legHeight", "radialSegments": 24 }
```

Maps directly to `THREE.CylinderGeometry`. Equal `radiusTop`/`radiusBottom` gives a
plain cylinder (e.g. the hanging rail); different values give a straight taper (e.g.
a tapered chair leg). `radialSegments` defaults to 24. **Not exportable yet.**

### 7.3 `lathe`

```jsonc
"geometry": {
  "profile": [[0, 0], [14, 0], [18, "backHeight * 0.15"], [10, "backHeight"], [0, "backHeight"]],
  "segments": 24
}
```

A profile of `[radius, y]` points revolved around the local y-axis — for a curved,
turned silhouette a straight cylinder taper can't express (e.g. a turned chair-back
post). The profile is **not auto-centered**; its y values are relative to wherever
this element's own `transform.position.y` places its base. Start and end the profile
at `radius: 0` to close the solid into a solid tip rather than leaving it open.
`segments` defaults to 24. **Not exportable yet.**

### 7.4 `extrude`

```jsonc
"geometry": {
  "outline": [["-w/2", "-d/2"], ["w/2", "-d/2"], ["w/2", "d/2"], ["-w/2", "d/2"]],
  "holes": [
    { "circle": { "x": 0, "y": 0, "radius": "holeDiameter / 2", "segments": 24 } }
  ],
  "depth": "thickness"
}
```

A 2D outline in local xy, extruded along local z by `depth`, **centered on z** (so a
panel of `depth: 18` spans z = −9 to +9 locally, same centering convention as `box`).
This is the shape for any panel that isn't a plain rectangle: one with cutouts (a
grommet hole, shelf-pin rows) or a non-rectangular silhouette.

- **`outline`** is either a literal point list `[[x, y], ...]`, or `{ "circle": {x,
  y, radius, segments} }` to make the outline itself a circle (e.g. a round bar —
  `x`/`y` default to 0, `segments` defaults to 24).
- **`holes`** is a list, each entry one of:
  - a literal point list,
  - `{ "circle": { x, y, radius, segments } }`,
  - `{ "polygon": [[x, y], ...] }`,

  and any of the object forms can also carry its own `"repeat": { count, as }`
  (§5.3) to place a pattern of identical holes — this is how the shelving unit's
  32 mm shelf-pin rows are built: one hole entry with `repeat.count` driven by a
  formula on the panel height, `repeat.as` used inside the hole's own `x`/`y`
  formulas.
- **A hole must lie entirely within the outline's bounding box** (checked against the
  outline's own min/max x and y, with a small tolerance) — the builder throws
  `RangeError: Extrude: a hole lies outside the panel outline` rather than silently
  producing a broken shape. Note this checks the *bounding box*, not that the hole is
  actually inside a non-rectangular outline — a hole in the corner of an L-shaped
  outline's bounding box, outside the material, would not be caught.

### 7.5 Adding a new shape (advanced)

`createBuilder(...).registerShape(name, (geometryDef, n) => THREE.BufferGeometry)`
lets host code add a shape the builder itself doesn't define, where `n` is the value
evaluator for that node's scope (call `n(someField)` on each geometry field you need).
**A shape added this way is not automatically exportable** — `exporter-collada.js`
only knows how to turn `"box"` and `"extrude"` resolved specs into Collada faces; a
custom shape needs matching support added there too before it can reach SketchUp.

## 8. Known limitations

These are real, current gaps — not oversights to guess around, things to design
against until they're addressed:

- **Material-string ambiguity** (§6): whether a `material` string is read literally
  or as a formula depends on whether it happens to match an existing materials key.
  No syntax currently distinguishes "always literal" from "always formula."
- **Only `box` and `extrude` export to Collada.** `cylinder` and `lathe` are
  preview/browser-only today.
- **No definition reuse.** There is no `$ref`/template mechanism — an element used
  twice (e.g. two visually-identical side panels) is written out twice in full. This
  is a deliberate, accepted tradeoff, not a bug: the format is data, not a
  programming language.
- **Every parameter change re-evaluates the entire tree**, not just the nodes that
  actually depend on the changed parameter. Fine at current model sizes; would need a
  real dependency graph to stay fast on much larger catalogues.
- **`unit` only accepts `"mm"`.** No other unit, and no per-value unit overrides
  beyond what you write literally inside a formula string.
- **Textures (`materials.*.map`) are unverified.** Browser-only, never tested end to
  end.
- **`repeat` inside `holes`, and `repeat` on nodes, share the same integer-count rule
  (0–500) and the same reserved-name hazard** — see §10.

## 9. Authoring checklist

Before writing a new model file:

1. Get real dimensions. Don't guess a number that should come from the actual
   product — leave a `_comment` flagging any assumption you had to make so a human
   can verify it (this is exactly what was done for the wardrobe's plinth height,
   divider position, and rail drop, none of which were in the original brief).
2. List the parameters first: what does a customer or staff member actually need to
   adjust? Give every `number` real `min`/`max` bounds, not placeholders.
3. Decide the coordinate convention up front and hold it for the whole file — every
   tested model so far uses: floor at y = 0, front toward +z, centered on x (and
   usually z). This isn't enforced by the builder, but breaking it makes a model
   inconsistent with the rest of the catalogue and harder to reason about.
4. Build up `variables` incrementally at the group level closest to where they're
   needed — don't put everything in the root group's variables if only one
   sub-section uses them.
5. For every panel that needs to reach SketchUp: use only `box` or `extrude`, and
   always set a real `material` key from the `materials` block.
6. If a panel has a cutout, a non-rectangular outline, or a repeating hole pattern,
   it's `extrude`, not `box`.
7. Run it through the builder and check it renders and resizes sanely before treating
   it as done — see §11 for how.

## 10. Common mistakes

- **Using `i`, `e`, `pi`, `phi`, `tau`, `true`, `false`, `null`, `Infinity`, or `NaN`
  as a parameter name, a group variable name, or a `repeat.as` loop variable name.**
  These (and a long list of physics constants — `avogadro`, `boltzmann`,
  `speedOfLight`, etc.) are predefined by mathjs and will silently shadow your
  intended value inside formulas, or throw, rather than doing what you meant. Prefer
  descriptive names like `shelfIndex`, `pinRow`, `doorIndex` — they also make formulas
  more readable.
- **Comparing an enum's name directly to a string**, e.g. `grommetPosition ==
  "left"`. This throws (§3) — always compare to `GrommetPosition.left`.
- **Forgetting `material` on an exportable element.** It won't fail — export still
  succeeds — but the panel arrives in SketchUp with no material assigned, which is
  easy to miss until someone's looking at the imported model.
- **Writing a hole outside the panel's own bounding box** — will throw at build time,
  not silently produce bad geometry, so this fails loudly and early; just don't
  ignore the error.
- **Giving two elements at the same nesting level the same literal `name`** when
  neither uses `repeat`. Nothing stops this, but the exporter's per-panel identifiers
  are derived from `name`, and two panels named identically will get suffixed ids
  (`node-Foo`, `node-Foo_2`) that no longer match what you called them in the JSON —
  keep names unique.
- **Assuming `repeat.count: 0` needs a `visible` guard too.** It doesn't — zero
  copies already means nothing is built.

## 11. Using the libraries directly (for testing a model file)

```js
import { createBuilder } from './builder.js';
import { createColladaExporter } from './exporter-collada.js';

const instance = createBuilder({ THREE, math }).build(modelDoc);
// instance.object      — a THREE.Group, add it to a scene
// instance.doc         — the original document (the exporter reads instance.doc.materials)
// instance.paramDefs   — the parameters object, for building a UI
// instance.getParams() — current values, { name: value, ... }
// instance.setParam(name, value)     — change one, validated, rebuilds the whole tree
// instance.setParams({ a: 1, b: 2 }) — change several atomically; if any value fails
//                                       validation, NONE of the changes are applied

const { exportCollada } = createColladaExporter({ THREE });
const xml = exportCollada(instance, {
  upAxis: 'Z_UP',        // default; 'Y_UP' also accepted
  name: instance.object.name,           // defaults to doc.meta.name
  created: new Date().toISOString(),    // defaults to now
});
// xml is a complete .dae file as a string — write it to disk or offer it as a download
```

`setParam`/`setParams` validate against each parameter's declared type/bounds and
throw (`RangeError`/`TypeError`) rather than silently clamping or coercing a bad
value — catch and surface that message to whoever is adjusting parameters, don't
suppress it.

### What the exporter actually does to your geometry

Understanding this explains why only `box`/`extrude` work, and why the output looks
the way it does if you inspect a `.dae` by hand:

- It does **not** read Three.js's triangulated `BufferGeometry`. It reads
  `mesh.userData.spec` — the resolved shape name and geometry values the builder
  attaches to every mesh at build time — and rebuilds real polygon faces from that
  (a box's 6 sides as single quads; an extrude's outline/hole walls as quads, with
  its flat top/bottom faces triangulated and left for SketchUp's own "Merge Coplanar
  Faces" import option, on by default, to reassemble into one face with the hole cut
  out).
- Every panel gets its **own, never-shared** geometry, even two panels that happen to
  be identical — so coloring an edge for banding on one panel in SketchUp can never
  leak onto another.
- Panels are nested `SketchUp > <model name> > <panel>...` in the output, matching
  the structure SketchUp's own Collada exporter produces — panels written directly
  under the scene root were found to import as merged, ungrouped loose geometry
  instead of separate components.
- Output is Z-up millimeters by default (SketchUp's own convention), which means an
  axis conversion from the builder's Y-up/front-is-+z convention happens inside the
  exporter — you don't need to account for this when writing model JSON, only when
  reading a raw `.dae` file by hand.