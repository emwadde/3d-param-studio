"""Run with:
  Dev:  uvicorn server.main:app --reload --port 8000   (Vite proxies /api/* here, see vite.config.js)
  Prod: uvicorn server.main:app --port 3000             (after `npm run build`; serves dist/ + the API)
"""

from pathlib import Path

from fastapi.staticfiles import StaticFiles

from server.app import create_app

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
IS_BUILT = DIST.is_dir()

app = create_app(models_dir=(DIST / "models") if IS_BUILT else ROOT / "public" / "models")

if IS_BUILT:
    # html=True serves dist/index.html for unmatched paths (e.g. /studio.html) with
    # extensions resolved automatically, and falls back to it for a bare "/".
    app.mount("/", StaticFiles(directory=DIST, html=True), name="static")
