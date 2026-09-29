"""API for 3D Param Studio.

Two routes:
  GET /api/models      -> catalogue list, built by reading meta.id/meta.name/parameters
                           out of every *.json in the models directory
  GET /api/models/{id} -> the raw JSON of one model, looked up by its meta.id (not its
                           filename, so files can be renamed on disk without breaking links)

A model file that isn't valid JSON, or is missing meta.id/meta.name, is skipped (and
logged) rather than taking the whole catalogue down.
"""

import json
import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException

logger = logging.getLogger("models")


def list_models(models_dir: Path) -> list[dict]:
    items = []
    for path in sorted(models_dir.glob("*.json")):
        try:
            doc = json.loads(path.read_text())
            meta = doc.get("meta") or {}
            if not meta.get("id") or not meta.get("name"):
                raise ValueError("missing meta.id or meta.name")
            items.append(
                {
                    "id": meta["id"],
                    "name": meta["name"],
                    "file": path.name,
                    "paramCount": len(doc.get("parameters") or {}),
                }
            )
        except (json.JSONDecodeError, ValueError) as e:
            logger.warning("skipping %s: %s", path.name, e)
    items.sort(key=lambda m: m["name"])
    return items


def create_app(models_dir: Path) -> FastAPI:
    app = FastAPI(title="3D Param Studio API")

    @app.get("/api/models")
    def get_models():
        return list_models(models_dir)

    @app.get("/api/models/{model_id}")
    def get_model(model_id: str):
        match = next((m for m in list_models(models_dir) if m["id"] == model_id), None)
        if match is None:
            raise HTTPException(status_code=404, detail="not found")
        return json.loads((models_dir / match["file"]).read_text())

    return app
