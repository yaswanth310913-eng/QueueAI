"""
QueueAI - AI/ML Prediction Engine
Implements:
  1. Mathematical baseline: wait ≈ (queue_length × avg_service_time) / active_counters
  2. Queueing theory improvement (M/M/c-inspired adjustment)
  3. scikit-learn gradient-boosted regressor (trained on historical data)
"""
import math
import warnings
from typing import Optional
import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

# ────────────────────────────────────────────────────────────────────────────
# 1.  Mathematical Baseline
# ────────────────────────────────────────────────────────────────────────────

def _congestion_status(wait_min: float, rules: dict) -> str:
    if wait_min <= rules.get("quiet_max_min", 5):
        return "Quiet"
    if wait_min <= rules.get("normal_max_min", 15):
        return "Normal"
    if wait_min <= rules.get("busy_max_min", 30):
        return "Busy"
    return "Very Busy"


def mathematical_prediction(
    queue_length: int,
    active_counters: int,
    avg_service_time: float,       # minutes
    arrival_rate: float = 1.0,     # people per minute
    people_being_served: int = 0,
    congestion_rules: Optional[dict] = None,
) -> dict:
    """
    Baseline formula with M/M/c-inspired correction.
    Returns a dict with all prediction fields.
    """
    rules = congestion_rules or {"quiet_max_min": 5, "normal_max_min": 15, "busy_max_min": 30}

    # Edge cases
    if active_counters <= 0:
        return {
            "predicted_wait_min": None,
            "lower_bound": None,
            "upper_bound": None,
            "congestion_status": "Very Busy",
            "prediction_method": "mathematical_baseline",
            "confidence": 0.0,
            "note": "No active counters. Service temporarily unavailable.",
            "error": True,
        }

    if queue_length < 0 or avg_service_time <= 0:
        return {
            "predicted_wait_min": None,
            "lower_bound": None,
            "upper_bound": None,
            "congestion_status": "Unknown",
            "prediction_method": "mathematical_baseline",
            "confidence": 0.0,
            "note": "Invalid queue data. Check input values.",
            "error": True,
        }

    # Base formula
    base_wait = (queue_length * avg_service_time) / active_counters

    # Arrival-rate adjustment: if arrivals > service capacity, queue is growing
    service_rate_total = active_counters / avg_service_time  # people/min
    utilisation = arrival_rate / service_rate_total if service_rate_total > 0 else 1.0
    utilisation = min(utilisation, 0.99)  # clamp — avoid division by zero in M/M/c

    # Simple utilisation-based multiplier
    if utilisation < 0.5:
        multiplier = 0.9
    elif utilisation < 0.8:
        multiplier = 1.0
    elif utilisation < 0.95:
        multiplier = 1.2
    else:
        multiplier = 1.6  # near-saturation

    adjusted_wait = base_wait * multiplier

    # Uncertainty bounds (±20 % baseline)
    lower = max(0.0, adjusted_wait * 0.80)
    upper = adjusted_wait * 1.25

    # Confidence: higher when utilisation is mid-range and queue is not tiny
    confidence = 0.75 - abs(utilisation - 0.6) * 0.5
    confidence = round(max(0.3, min(0.9, confidence)), 2)

    status = _congestion_status(adjusted_wait, rules)

    return {
        "predicted_wait_min": round(adjusted_wait, 1),
        "lower_bound": round(lower, 1),
        "upper_bound": round(upper, 1),
        "congestion_status": status,
        "prediction_method": "mathematical_baseline",
        "confidence": confidence,
        "utilisation": round(utilisation, 2),
        "base_formula_wait": round(base_wait, 1),
        "note": f"Baseline: ({queue_length} × {avg_service_time}) ÷ {active_counters} = {base_wait:.1f} min, adjusted × {multiplier}",
        "error": False,
    }


# ────────────────────────────────────────────────────────────────────────────
# 2.  ML Model (scikit-learn GradientBoostingRegressor)
# ────────────────────────────────────────────────────────────────────────────

_model_cache: dict = {}   # centre_id → {model, mae, trained_at}


def _build_features(df: pd.DataFrame) -> pd.DataFrame:
    """Engineer features from a queue_snapshots-style DataFrame."""
    df = df.copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df["hour"] = df["timestamp"].dt.hour
    df["dow"] = df["timestamp"].dt.dayofweek   # 0=Mon … 6=Sun
    df["is_weekend"] = (df["dow"] >= 5).astype(int)

    # Throughput capacity (people/min)
    df["capacity"] = df["active_counters"] / df["avg_service_time"].clip(lower=0.1)
    # Utilisation
    df["utilisation"] = (df["arrival_rate"] / df["capacity"].clip(lower=0.01)).clip(upper=2.0)
    # Effective load
    df["effective_load"] = df["queue_length"] / df["active_counters"].clip(lower=1)

    # Target: actual wait from mathematical baseline (proxy — real wait would come from service records)
    df["target_wait"] = (
        df["queue_length"] * df["avg_service_time"]
    ) / df["active_counters"].clip(lower=1)

    return df


FEATURE_COLS = [
    "queue_length", "active_counters", "avg_service_time",
    "arrival_rate", "people_being_served",
    "hour", "dow", "is_weekend",
    "utilisation", "effective_load", "capacity",
]


def train_model(snapshots: list[dict], centre_id: int) -> dict:
    """
    Train GradientBoostingRegressor on historical snapshots.
    Returns training report dict.
    """
    try:
        from sklearn.ensemble import GradientBoostingRegressor
        from sklearn.metrics import mean_absolute_error
    except ImportError:
        return {"success": False, "error": "scikit-learn not installed"}

    if len(snapshots) < 30:
        return {
            "success": False,
            "error": f"Insufficient data: {len(snapshots)} records (need ≥ 30)",
            "records": len(snapshots),
        }

    df = pd.DataFrame(snapshots)
    df = _build_features(df)
    df.dropna(subset=FEATURE_COLS + ["target_wait"], inplace=True)

    X = df[FEATURE_COLS].values
    y = df["target_wait"].values

    # Chronological split (80/20)
    split = int(len(X) * 0.8)
    X_train, X_test = X[:split], X[split:]
    y_train, y_test = y[:split], y[split:]

    if len(X_train) < 10:
        return {"success": False, "error": "Not enough training records after split."}

    model = GradientBoostingRegressor(
        n_estimators=200, max_depth=4, learning_rate=0.05,
        subsample=0.8, random_state=42
    )
    model.fit(X_train, y_train)

    preds_test = model.predict(X_test)
    mae = mean_absolute_error(y_test, preds_test)

    # Feature importances
    importances = dict(zip(FEATURE_COLS, model.feature_importances_.tolist()))

    _model_cache[centre_id] = {
        "model": model,
        "mae": round(mae, 2),
        "trained_at": pd.Timestamp.now().isoformat(),
        "train_size": len(X_train),
        "test_size": len(X_test),
    }

    return {
        "success": True,
        "centre_id": centre_id,
        "mae_minutes": round(mae, 2),
        "train_records": len(X_train),
        "test_records": len(X_test),
        "feature_importances": importances,
        "model_version": "GBR-v1.0",
    }


def ml_prediction(
    queue_length: int,
    active_counters: int,
    avg_service_time: float,
    arrival_rate: float,
    people_being_served: int,
    hour: int,
    dow: int,
    centre_id: int,
    congestion_rules: Optional[dict] = None,
) -> dict:
    """
    Predict using the cached ML model; fall back to mathematical baseline.
    """
    rules = congestion_rules or {"quiet_max_min": 5, "normal_max_min": 15, "busy_max_min": 30}

    if centre_id not in _model_cache:
        result = mathematical_prediction(
            queue_length, active_counters, avg_service_time,
            arrival_rate, people_being_served, rules
        )
        result["prediction_method"] = "mathematical_baseline (ML model not yet trained)"
        return result

    cache = _model_cache[centre_id]
    model = cache["model"]

    cap = active_counters / max(avg_service_time, 0.1)
    util = min(arrival_rate / max(cap, 0.01), 2.0)
    eff_load = queue_length / max(active_counters, 1)
    is_weekend = int(dow >= 5)

    features = np.array([[
        queue_length, active_counters, avg_service_time,
        arrival_rate, people_being_served,
        hour, dow, is_weekend,
        util, eff_load, cap,
    ]])

    pred = float(model.predict(features)[0])
    pred = max(0.0, pred)

    mae = cache["mae"]
    lower = max(0.0, pred - mae)
    upper = pred + mae

    status = _congestion_status(pred, rules)

    return {
        "predicted_wait_min": round(pred, 1),
        "lower_bound": round(lower, 1),
        "upper_bound": round(upper, 1),
        "congestion_status": status,
        "prediction_method": f"ML/GradientBoosting (MAE={mae} min)",
        "confidence": round(max(0.5, 0.95 - mae / 20), 2),
        "note": f"Trained on {cache['train_size']} records. Test MAE = {mae} min.",
        "error": False,
    }


# ────────────────────────────────────────────────────────────────────────────
# 3.  Best-Time-to-Visit Analysis
# ────────────────────────────────────────────────────────────────────────────

def best_time_analysis(snapshots: list[dict]) -> dict:
    """
    Compute mean predicted wait by hour using historical snapshots.
    Returns recommended visiting windows.
    """
    if len(snapshots) < 20:
        return {
            "available": False,
            "message": "Insufficient historical data for best-time analysis (need ≥ 20 snapshots).",
            "hourly_avg": [],
        }

    df = pd.DataFrame(snapshots)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df["hour"] = df["timestamp"].dt.hour
    df["wait_est"] = (
        df["queue_length"] * df["avg_service_time"]
    ) / df["active_counters"].clip(lower=1)

    hourly = (
        df.groupby("hour")["wait_est"]
        .agg(["mean", "std", "count"])
        .reset_index()
        .rename(columns={"mean": "avg_wait", "std": "std_wait", "count": "n_obs"})
    )
    hourly["avg_wait"] = hourly["avg_wait"].round(1)
    hourly["std_wait"] = hourly["std_wait"].fillna(0).round(1)
    hourly["confidence"] = (hourly["n_obs"] / hourly["n_obs"].max()).clip(upper=1.0).round(2)

    # Label busy / quiet
    threshold_busy = hourly["avg_wait"].quantile(0.7)
    threshold_quiet = hourly["avg_wait"].quantile(0.3)

    def label(row):
        if row["avg_wait"] <= threshold_quiet:
            return "Quiet"
        if row["avg_wait"] >= threshold_busy:
            return "Busy"
        return "Normal"

    hourly["label"] = hourly.apply(label, axis=1)

    # Best window: consecutive quiet hours
    quiet_hours = hourly[hourly["label"] == "Quiet"]["hour"].tolist()
    recommendation = (
        f"Visit between {quiet_hours[0]:02d}:00–{quiet_hours[-1]+1:02d}:00 for shortest queues."
        if quiet_hours else "No clearly quiet period identified."
    )

    return {
        "available": True,
        "hourly_avg": hourly.to_dict(orient="records"),
        "recommended_hours": quiet_hours,
        "busy_hours": hourly[hourly["label"] == "Busy"]["hour"].tolist(),
        "recommendation": recommendation,
        "disclaimer": "Estimates only. Do not delay urgent medical care due to queue predictions.",
    }
