# 3D Param Studio

A browser-based studio for **parametric 3D models**. Pick a model from the catalogue, tweak its parameters (sliders, enums, etc.) and watch it rebuild live in 3D, then export it as a **COLLADA (`.dae`)** file that imports into SketchUp.

Models are plain JSON files. Dimensions can be literal numbers or [mathjs](https://mathjs.org) formulas that reference parameters, so a wardrobe can resize its doors, shelves and panels from a handful of inputs.

## Features

- Catalogue of models served from a small FastAPI backend
- Live 3D viewport (three.js) with orbit / pan / zoom, touch-friendly
- Auto-generated parameter controls per model
- Formula-driven geometry: `box`, `cylinder`, `lathe`, `extrude` (with holes), groups, rotations and `repeat`
- One-click COLLADA export for SketchUp

Bundled example models live in [public/models/](public/models/): `chair`, `carcass`, `shelving-unit`, `panel-with-hole`, `wardrobe-3-door`.

## Requirements

- Node.js (npm or Bun)
- Python 3.10+ (developed on 3.13)

## Setup

```bash
npm install                      # also copies three.js and mathjs into public/vendor (postinstall)
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Running

**Development** (API on :8000, Vite on :5173 with `/api` proxied to the API):

```bash
npm run dev
```

Open http://localhost:5173.

**Production** (single server serving the built app and the API):

```bash
npm run build
npm start
```

Open http://localhost:3000.

| Script | What it does |
| --- | --- |
| `npm run dev` | API + Vite together |
| `npm run dev:api` / `dev:web` | Run either one alone |
| `npm run build` | Vite build into `dist/` |
| `npm start` | Serve `dist/` and the API on port 3000 |
| `npm run vendor` | Re-copy three.js / mathjs into `public/vendor` |

## Project layout

```
index.html, studio.html     Catalogue page and 3D studio page
src/js/catalogue.js         Fetches /api/models and renders the grid
src/js/studio.js            Viewport, parameter panel, export button
src/js/builder.js           Turns a model JSON into a three.js scene
src/js/exporter-collada.js  Writes a model to SketchUp-ready .dae
src/css/                    Styles
server/app.py               API: list_models + create_app
server/main.py              App entry point; serves dist/ when built
public/models/              Model JSON files (the catalogue)
public/vendor/              Vendored three.min.js and math.js (generated)
MODEL-SPEC.md               Full model file format specification
```

## API

| Route | Description |
| --- | --- |
| `GET /api/models` | List of `{ id, name, file, paramCount }`, sorted by name |
| `GET /api/models/{id}` | Raw model JSON, looked up by `meta.id` (not filename) |

Model files that are invalid JSON or lack `meta.id` / `meta.name` are skipped and logged rather than breaking the catalogue.

## Adding a model

1. Create a `.json` file in [public/models/](public/models/) with a unique, lowercase-hyphenated `meta.id`.
2. Follow [MODEL-SPEC.md](MODEL-SPEC.md). It is written so a person or an AI agent can author a valid model without other context.
3. Reload the catalogue. In production, rebuild first (`npm run build`), since models are served from `dist/models`.

Minimal shape:

```jsonc
{
  "schemaVersion": "1.0",
  "unit": "mm",
  "meta": { "id": "my-model", "name": "My Model" },
  "parameters": { /* user-adjustable inputs */ },
  "materials":  { /* named colours */ },
  "root": { /* a "group" node containing shapes */ }
}
```

A JSON number is a literal; a JSON string is a mathjs formula (e.g. `"deskWidth / 2 - thickness"`). Units are millimetres.

## Notes

- The model format is v0 and still evolving; see "Known limitations" in [MODEL-SPEC.md](MODEL-SPEC.md).
