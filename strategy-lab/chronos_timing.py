"""Optional local Chronos-2 timing inference for AlphaEdge shadow mode.

This module is deliberately fail-closed. It never places orders and returns
``ok=False`` when chronos-forecasting is not installed or the input is invalid.
Install only in the bridge Python environment when ready::

    pip install "chronos-forecasting>=2.0" torch pandas numpy
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

MODEL = "chronos-2"
MODEL_VERSION = "chronos-2-shadow-v1"


def _number(value: Any):
    try:
        number = float(value)
        return number if number == number else None
    except (TypeError, ValueError):
        return None


def _result_error(message: str) -> dict[str, Any]:
    return {"ok": False, "shadowOnly": True, "model": MODEL, "modelVersion": MODEL_VERSION, "error": message}


def forecast_timing(req: dict[str, Any]) -> dict[str, Any]:
    series = req.get("series") or []
    entry = _number(req.get("entryPremium"))
    stop = _number(req.get("stopPremium"))
    target = _number(req.get("targetPremium"))
    horizon = int(req.get("horizonMin") or 10)
    values = [_number(row.get("target")) for row in series if isinstance(row, dict)]
    values = [value for value in values if value is not None and value > 0]
    if len(values) < 20 or not entry or entry <= 0:
        return _result_error("at least 20 valid premium observations are required")

    try:
        import numpy as np
        import pandas as pd
        from chronos import Chronos2Pipeline
    except ImportError as exc:
        return _result_error(f"Chronos is not installed: {exc}")

    try:
        # Keep one process/model resident in the bridge worker. The caller sends
        # the selected option only, so the model never chooses the strike.
        pipeline = _get_pipeline(Chronos2Pipeline)
        frame = pd.DataFrame({
            "id": [str(req.get("underlying", "OPTION")) + "_" + str(req.get("strike", ""))] * len(values),
            "timestamp": pd.date_range(end=datetime.now(timezone.utc), periods=len(values), freq="min"),
            "target": np.asarray(values, dtype=float),
        })
        prediction = pipeline.predict_df(
            frame,
            prediction_length=max(1, min(horizon, 30)),
            quantile_levels=[0.1, 0.5, 0.9],
            id_column="id",
            timestamp_column="timestamp",
            target="target",
        )
        row = prediction.iloc[-1].to_dict()
        quantiles = _extract_quantiles(row)
        if any(value is None for value in quantiles):
            return _result_error("Chronos response did not contain q10/q50/q90")
        return {
            "ok": True,
            "shadowOnly": True,
            "model": MODEL,
            "modelVersion": MODEL_VERSION,
            "horizonMin": horizon,
            "dataTimestamp": datetime.now(timezone.utc).isoformat(),
            "q10": quantiles[0], "q50": quantiles[1], "q90": quantiles[2],
            "entryPremium": entry, "stopPremium": stop, "targetPremium": target,
        }
    except Exception as exc:  # inference errors must not affect deterministic trading logic
        return _result_error(f"Chronos inference failed: {exc}")


_PIPELINE = None


def _get_pipeline(pipeline_type):
    global _PIPELINE
    if _PIPELINE is None:
        _PIPELINE = pipeline_type.from_pretrained("amazon/chronos-2", device_map="cpu")
    return _PIPELINE


def _extract_quantiles(row: dict[str, Any]):
    def find(level):
        keys = (str(level), f"{level:.1f}", f"q{int(level * 100)}", f"{level * 100:.1f}%")
        for key in keys:
            if key in row:
                return _number(row[key])
        return None

    return find(0.1), find(0.5), find(0.9)
