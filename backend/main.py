"""
QueueAI – FastAPI Backend
All API routes for queue management, predictions, admin, and analytics.
"""

import csv
import io
import json
import random
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import sys
from pathlib import Path

# Ensure backend directory is in sys.path so local modules resolve from any working directory
BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from database import get_db, init_db, _seed_demo_data
from predictor import (
    best_time_analysis,
    mathematical_prediction,
    ml_prediction,
    train_model,
    _model_cache,
)

# ────────────────────────────────────────────────────────────────────────────
app = FastAPI(title="QueueAI API", version="1.0.0", docs_url="/api/docs")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Static files
STATIC = Path(__file__).parent.parent / "frontend"
if STATIC.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")

# ────────────────────────────────────────────────────────────────────────────
# Startup
# ────────────────────────────────────────────────────────────────────────────
@app.on_event("startup")
async def startup():
    init_db()
    # Kick off background demo simulator
    threading.Thread(target=_demo_simulator, daemon=True).start()


# ────────────────────────────────────────────────────────────────────────────
# Pydantic Models
# ────────────────────────────────────────────────────────────────────────────
class QueueUpdate(BaseModel):
    queue_length: int = Field(..., ge=0)
    active_counters: int = Field(..., ge=0)
    avg_service_time: float = Field(5.0, gt=0)
    arrival_rate: float = Field(1.0, ge=0)
    people_being_served: int = Field(0, ge=0)
    note: Optional[str] = None


class CentreCreate(BaseModel):
    name: str
    service_type: str
    location: str
    operating_hours: str = "09:00-17:00"
    status: str = "active"


class AdminLogin(BaseModel):
    username: str
    password: str


class ThresholdUpdate(BaseModel):
    quiet_max_min: float = Field(5.0, gt=0)
    normal_max_min: float = Field(15.0, gt=0)
    busy_max_min: float = Field(30.0, gt=0)


# ────────────────────────────────────────────────────────────────────────────
# Auth (session via cookie — simple demo auth)
# ────────────────────────────────────────────────────────────────────────────
_sessions: dict[str, dict] = {}  # token → {username, role}


def _get_session(request: Request) -> Optional[dict]:
    token = request.cookies.get("queueai_session")
    return _sessions.get(token)


def require_auth(request: Request):
    session = _get_session(request)
    if not session:
        raise HTTPException(status_code=401, detail="Authentication required")
    return session


def require_admin(request: Request):
    session = require_auth(request)
    if session["role"] not in ("admin", "superadmin"):
        raise HTTPException(status_code=403, detail="Admin access required")
    return session


# ────────────────────────────────────────────────────────────────────────────
# Serve Frontend
# ────────────────────────────────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
async def serve_frontend():
    index = STATIC / "index.html"
    if index.exists():
        return HTMLResponse(index.read_text(encoding="utf-8"))
    return HTMLResponse("<h1>QueueAI: Place frontend/index.html in the frontend/ directory.</h1>")


# ────────────────────────────────────────────────────────────────────────────
# Auth Routes
# ────────────────────────────────────────────────────────────────────────────
@app.post("/api/auth/login")
async def login(body: AdminLogin, response: Response):
    db = get_db()
    row = db.execute(
        "SELECT * FROM administrators WHERE username=?", (body.username,)
    ).fetchone()
    db.close()
    if not row or row["password"] != body.password:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    import secrets
    token = secrets.token_hex(32)
    _sessions[token] = {"username": row["username"], "role": row["role"], "id": row["id"]}
    db2 = get_db()
    db2.execute(
        "UPDATE administrators SET last_login=datetime('now') WHERE id=?", (row["id"],)
    )
    db2.commit()
    db2.close()

    response.set_cookie("queueai_session", token, httponly=True, samesite="lax")
    return {"success": True, "username": row["username"], "role": row["role"]}


@app.post("/api/auth/logout")
async def logout(request: Request, response: Response):
    token = request.cookies.get("queueai_session")
    _sessions.pop(token, None)
    response.delete_cookie("queueai_session")
    return {"success": True}


@app.get("/api/auth/me")
async def me(request: Request):
    session = _get_session(request)
    if not session:
        return {"authenticated": False}
    return {"authenticated": True, **session}


# ────────────────────────────────────────────────────────────────────────────
# Service Centres
# ────────────────────────────────────────────────────────────────────────────
def _get_rules(db, centre_id: int) -> dict:
    row = db.execute(
        "SELECT * FROM congestion_rules WHERE centre_id=?", (centre_id,)
    ).fetchone()
    if row:
        return dict(row)
    return {"quiet_max_min": 5, "normal_max_min": 15, "busy_max_min": 30}


def _enrich_centre(db, row) -> dict:
    c = dict(row)
    snap = db.execute(
        "SELECT * FROM queue_snapshots WHERE centre_id=? ORDER BY timestamp DESC LIMIT 1",
        (c["id"],)
    ).fetchone()
    if snap:
        snap = dict(snap)
        rules = _get_rules(db, c["id"])
        pred = mathematical_prediction(
            snap["queue_length"],
            snap["active_counters"],
            snap["avg_service_time"],
            snap.get("arrival_rate", 1.0),
            snap.get("people_being_served", 0),
            rules,
        )
        c.update({
            "queue_length": snap["queue_length"],
            "active_counters": snap["active_counters"],
            "people_being_served": snap.get("people_being_served", 0),
            "avg_service_time": snap["avg_service_time"],
            "arrival_rate": snap.get("arrival_rate", 1.0),
            "last_updated": snap["timestamp"],
            "is_demo": bool(snap.get("is_demo", 0)),
            "predicted_wait_min": pred.get("predicted_wait_min"),
            "congestion_status": pred.get("congestion_status", "Unknown"),
            "lower_bound": pred.get("lower_bound"),
            "upper_bound": pred.get("upper_bound"),
            "prediction_note": pred.get("note", ""),
        })
    else:
        c.update({
            "queue_length": None, "active_counters": None, "people_being_served": None,
            "last_updated": None, "is_demo": False,
            "predicted_wait_min": None, "congestion_status": "Unknown",
        })
    return c


@app.get("/api/centres")
async def list_centres(
    service_type: Optional[str] = None,
    location: Optional[str] = None,
    max_wait: Optional[float] = None,
    search: Optional[str] = None,
):
    db = get_db()
    rows = db.execute("SELECT * FROM service_centres WHERE status != 'inactive'").fetchall()
    result = [_enrich_centre(db, r) for r in rows]
    db.close()

    if service_type:
        result = [c for c in result if c["service_type"].lower() == service_type.lower()]
    if location:
        result = [c for c in result if location.lower() in c["location"].lower()]
    if max_wait is not None:
        result = [c for c in result if c.get("predicted_wait_min") is not None and c["predicted_wait_min"] <= max_wait]
    if search:
        s = search.lower()
        result = [c for c in result if s in c["name"].lower() or s in c["service_type"].lower() or s in c["location"].lower()]

    return result


@app.get("/api/centres/{centre_id}")
async def get_centre(centre_id: int):
    db = get_db()
    row = db.execute("SELECT * FROM service_centres WHERE id=?", (centre_id,)).fetchone()
    if not row:
        db.close()
        raise HTTPException(status_code=404, detail="Centre not found")
    result = _enrich_centre(db, row)
    db.close()
    return result


@app.post("/api/centres", dependencies=[Depends(require_admin)])
async def create_centre(body: CentreCreate):
    db = get_db()
    cur = db.execute(
        "INSERT INTO service_centres (name, service_type, location, operating_hours, status) VALUES (?,?,?,?,?)",
        (body.name, body.service_type, body.location, body.operating_hours, body.status),
    )
    db.execute(
        "INSERT INTO congestion_rules (centre_id) VALUES (?)", (cur.lastrowid,)
    )
    db.commit()
    centre_id = cur.lastrowid
    db.close()
    return {"success": True, "centre_id": centre_id}


@app.put("/api/centres/{centre_id}", dependencies=[Depends(require_admin)])
async def update_centre(centre_id: int, body: CentreCreate):
    db = get_db()
    db.execute(
        "UPDATE service_centres SET name=?,service_type=?,location=?,operating_hours=?,status=?,updated_at=datetime('now') WHERE id=?",
        (body.name, body.service_type, body.location, body.operating_hours, body.status, centre_id),
    )
    db.commit()
    db.close()
    return {"success": True}


# ────────────────────────────────────────────────────────────────────────────
# Queue Updates
# ────────────────────────────────────────────────────────────────────────────
@app.post("/api/centres/{centre_id}/queue")
async def update_queue(centre_id: int, body: QueueUpdate, request: Request):
    # Auth: admin OR demo mode
    session = _get_session(request)
    is_admin = session and session["role"] in ("admin", "superadmin")

    db = get_db()
    row = db.execute("SELECT * FROM service_centres WHERE id=?", (centre_id,)).fetchone()
    if not row:
        db.close()
        raise HTTPException(status_code=404, detail="Centre not found")

    db.execute(
        """INSERT INTO queue_snapshots
           (centre_id, queue_length, active_counters, people_being_served, avg_service_time, arrival_rate, is_demo, note)
           VALUES (?,?,?,?,?,?,?,?)""",
        (centre_id, body.queue_length, body.active_counters, body.people_being_served,
         body.avg_service_time, body.arrival_rate, 0 if is_admin else 1, body.note),
    )
    db.commit()

    rules = _get_rules(db, centre_id)
    pred = mathematical_prediction(
        body.queue_length, body.active_counters, body.avg_service_time,
        body.arrival_rate, body.people_being_served, rules
    )

    # Store prediction
    if not pred.get("error"):
        db.execute(
            """INSERT INTO predictions
               (centre_id, predicted_wait_min, prediction_method, confidence, lower_bound, upper_bound, congestion_status)
               VALUES (?,?,?,?,?,?,?)""",
            (centre_id, pred["predicted_wait_min"], pred["prediction_method"],
             pred.get("confidence"), pred.get("lower_bound"), pred.get("upper_bound"),
             pred.get("congestion_status")),
        )
        db.commit()
    db.close()

    return {"success": True, "prediction": pred}


# ────────────────────────────────────────────────────────────────────────────
# Prediction
# ────────────────────────────────────────────────────────────────────────────
@app.get("/api/centres/{centre_id}/predict")
async def predict(centre_id: int):
    db = get_db()
    snap = db.execute(
        "SELECT * FROM queue_snapshots WHERE centre_id=? ORDER BY timestamp DESC LIMIT 1",
        (centre_id,)
    ).fetchone()
    if not snap:
        db.close()
        raise HTTPException(status_code=404, detail="No queue data for this centre")

    snap = dict(snap)
    rules = _get_rules(db, centre_id)
    db.close()

    now = datetime.now()
    result = ml_prediction(
        snap["queue_length"], snap["active_counters"], snap["avg_service_time"],
        snap.get("arrival_rate", 1.0), snap.get("people_being_served", 0),
        now.hour, now.weekday(), centre_id, rules
    )
    return result


@app.post("/api/centres/{centre_id}/train", dependencies=[Depends(require_admin)])
async def train_centre_model(centre_id: int):
    db = get_db()
    rows = db.execute(
        "SELECT * FROM queue_snapshots WHERE centre_id=? ORDER BY timestamp ASC",
        (centre_id,)
    ).fetchall()
    db.close()

    snapshots = [dict(r) for r in rows]
    result = train_model(snapshots, centre_id)
    return result


# ────────────────────────────────────────────────────────────────────────────
# Best Time to Visit
# ────────────────────────────────────────────────────────────────────────────
@app.get("/api/centres/{centre_id}/best-time")
async def get_best_time(centre_id: int):
    db = get_db()
    rows = db.execute(
        "SELECT * FROM queue_snapshots WHERE centre_id=? ORDER BY timestamp ASC",
        (centre_id,)
    ).fetchall()
    db.close()
    return best_time_analysis([dict(r) for r in rows])


# ────────────────────────────────────────────────────────────────────────────
# Analytics
# ────────────────────────────────────────────────────────────────────────────
@app.get("/api/centres/{centre_id}/analytics")
async def get_analytics(centre_id: int, days: int = 14):
    db = get_db()
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
    rows = db.execute(
        """SELECT timestamp, queue_length, active_counters, avg_service_time, arrival_rate
           FROM queue_snapshots WHERE centre_id=? AND timestamp >= ? ORDER BY timestamp ASC""",
        (centre_id, cutoff)
    ).fetchall()
    preds = db.execute(
        """SELECT timestamp, predicted_wait_min, actual_wait_min, congestion_status
           FROM predictions WHERE centre_id=? AND timestamp >= ? ORDER BY timestamp ASC""",
        (centre_id, cutoff)
    ).fetchall()
    db.close()

    snaps = [dict(r) for r in rows]
    for s in snaps:
        s["est_wait"] = round(
            (s["queue_length"] * s["avg_service_time"]) / max(s["active_counters"], 1), 1
        )

    return {
        "snapshots": snaps,
        "predictions": [dict(p) for p in preds],
    }


@app.get("/api/dashboard")
async def dashboard_summary():
    db = get_db()
    centres = db.execute("SELECT id FROM service_centres WHERE status='active'").fetchall()
    total = len(centres)

    all_data = []
    for c in centres:
        snap = db.execute(
            "SELECT * FROM queue_snapshots WHERE centre_id=? ORDER BY timestamp DESC LIMIT 1",
            (c["id"],)
        ).fetchone()
        if snap:
            all_data.append(dict(snap))

    db.close()

    if not all_data:
        return {"total_centres": total, "total_waiting": 0, "avg_wait": None,
                "busy_count": 0, "shortest_queue": None, "congestion_level": "Unknown"}

    total_waiting = sum(d["queue_length"] for d in all_data)
    waits = []
    for d in all_data:
        if d["active_counters"] > 0:
            w = (d["queue_length"] * d["avg_service_time"]) / d["active_counters"]
            waits.append(w)

    avg_wait = round(sum(waits) / len(waits), 1) if waits else None
    busy_count = sum(1 for w in waits if w > 15)
    shortest = min(waits) if waits else None

    if avg_wait is None:
        congestion = "Unknown"
    elif avg_wait <= 5:
        congestion = "Quiet"
    elif avg_wait <= 15:
        congestion = "Normal"
    elif avg_wait <= 30:
        congestion = "Busy"
    else:
        congestion = "Very Busy"

    return {
        "total_centres": total,
        "total_waiting": total_waiting,
        "avg_wait_min": avg_wait,
        "busy_count": busy_count,
        "shortest_queue_min": round(shortest, 1) if shortest else None,
        "congestion_level": congestion,
    }


@app.get("/api/alerts")
async def get_alerts():
    db = get_db()
    centres = db.execute("SELECT * FROM service_centres WHERE status='active'").fetchall()
    alerts = []

    for c in centres:
        c = dict(c)
        snap = db.execute(
            "SELECT * FROM queue_snapshots WHERE centre_id=? ORDER BY timestamp DESC LIMIT 1",
            (c["id"],)
        ).fetchone()
        if not snap:
            continue
        snap = dict(snap)
        rules = _get_rules(db, c["id"])

        if snap["active_counters"] == 0:
            alerts.append({
                "centre_id": c["id"],
                "centre_name": c["name"],
                "type": "counter_unavailable",
                "severity": "critical",
                "message": f"No active counters at {c['name']}. Service temporarily unavailable.",
                "timestamp": snap["timestamp"],
            })
            continue

        wait = (snap["queue_length"] * snap["avg_service_time"]) / snap["active_counters"]

        if wait > rules["busy_max_min"]:
            severity = "high" if wait > rules["busy_max_min"] * 1.5 else "medium"
            alerts.append({
                "centre_id": c["id"],
                "centre_name": c["name"],
                "type": "high_wait",
                "severity": severity,
                "message": f"Wait at {c['name']} is {wait:.0f} min — exceeds {rules['busy_max_min']:.0f} min threshold.",
                "timestamp": snap["timestamp"],
            })

        cap = snap["active_counters"] / snap["avg_service_time"]
        if snap.get("arrival_rate", 0) > cap * 1.2:
            alerts.append({
                "centre_id": c["id"],
                "centre_name": c["name"],
                "type": "demand_exceeds_capacity",
                "severity": "medium",
                "message": f"Arrival rate ({snap['arrival_rate']:.1f}/min) exceeds capacity ({cap:.1f}/min) at {c['name']}.",
                "timestamp": snap["timestamp"],
            })

    db.close()
    return {"alerts": alerts, "count": len(alerts)}


# ────────────────────────────────────────────────────────────────────────────
# Admin Routes
# ────────────────────────────────────────────────────────────────────────────
@app.get("/api/admin/centres", dependencies=[Depends(require_admin)])
async def admin_list_centres():
    db = get_db()
    rows = db.execute("SELECT * FROM service_centres").fetchall()
    result = [_enrich_centre(db, r) for r in rows]
    db.close()
    return result


@app.put("/api/admin/centres/{centre_id}/thresholds", dependencies=[Depends(require_admin)])
async def update_thresholds(centre_id: int, body: ThresholdUpdate):
    if not (body.quiet_max_min < body.normal_max_min < body.busy_max_min):
        raise HTTPException(status_code=400, detail="Thresholds must be in ascending order")
    db = get_db()
    existing = db.execute("SELECT id FROM congestion_rules WHERE centre_id=?", (centre_id,)).fetchone()
    if existing:
        db.execute(
            "UPDATE congestion_rules SET quiet_max_min=?, normal_max_min=?, busy_max_min=? WHERE centre_id=?",
            (body.quiet_max_min, body.normal_max_min, body.busy_max_min, centre_id)
        )
    else:
        db.execute(
            "INSERT INTO congestion_rules (centre_id, quiet_max_min, normal_max_min, busy_max_min) VALUES (?,?,?,?)",
            (centre_id, body.quiet_max_min, body.normal_max_min, body.busy_max_min)
        )
    db.commit()
    db.close()
    return {"success": True}


@app.get("/api/admin/export/{centre_id}", dependencies=[Depends(require_admin)])
async def export_csv(centre_id: int):
    db = get_db()
    rows = db.execute(
        "SELECT * FROM queue_snapshots WHERE centre_id=? ORDER BY timestamp ASC",
        (centre_id,)
    ).fetchall()
    db.close()

    output = io.StringIO()
    if rows:
        writer = csv.DictWriter(output, fieldnames=dict(rows[0]).keys())
        writer.writeheader()
        writer.writerows([dict(r) for r in rows])
    output.seek(0)

    return StreamingResponse(
        io.BytesIO(output.read().encode()),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=queue_data_centre_{centre_id}.csv"},
    )


@app.post("/api/admin/reset-demo", dependencies=[Depends(require_admin)])
async def reset_demo():
    """Delete demo snapshots and re-seed."""
    from database import _seed_demo_data
    db = get_db()
    db.execute("DELETE FROM queue_snapshots WHERE is_demo=1")
    db.execute("DELETE FROM predictions")
    db.commit()
    _seed_demo_data(db)
    db.close()
    return {"success": True, "message": "Demo data reset successfully."}


@app.get("/api/admin/model-status", dependencies=[Depends(require_admin)])
async def model_status():
    status_list = []
    for cid, info in _model_cache.items():
        status_list.append({
            "centre_id": cid,
            "mae_minutes": info["mae"],
            "trained_at": info["trained_at"],
            "train_size": info["train_size"],
            "test_size": info["test_size"],
        })
    return {"models": status_list}


# ────────────────────────────────────────────────────────────────────────────
# Demo Simulation (runs in background thread)
# ────────────────────────────────────────────────────────────────────────────
_demo_running = True


def _demo_simulator():
    """
    Every 30 seconds, slightly update queue lengths for demo centres
    to simulate realistic real-time queue changes.
    """
    import random as rnd
    rnd.seed()

    while _demo_running:
        time.sleep(30)
        try:
            db = get_db()
            centres = db.execute("SELECT id FROM service_centres").fetchall()
            for c in centres:
                snap = db.execute(
                    "SELECT * FROM queue_snapshots WHERE centre_id=? ORDER BY timestamp DESC LIMIT 1",
                    (c["id"],)
                ).fetchone()
                if not snap:
                    continue
                snap = dict(snap)

                hour = datetime.now().hour
                if 10 <= hour <= 12 or 14 <= hour <= 16:
                    delta = rnd.randint(-2, 4)
                elif hour < 9 or hour > 17:
                    delta = rnd.randint(-3, 1)
                else:
                    delta = rnd.randint(-2, 3)

                new_ql = max(0, snap["queue_length"] + delta)
                ac_change = rnd.choices([0, 1, -1], weights=[0.8, 0.1, 0.1])[0]
                new_ac = max(1, min(6, snap["active_counters"] + ac_change))
                new_ar = max(0.1, snap.get("arrival_rate", 1.0) + rnd.uniform(-0.3, 0.3))

                db.execute(
                    """INSERT INTO queue_snapshots
                       (centre_id, queue_length, active_counters, people_being_served,
                        avg_service_time, arrival_rate, is_demo, note)
                       VALUES (?,?,?,?,?,?,1,'DEMO DATA - simulated update')""",
                    (c["id"], new_ql, new_ac, min(new_ac, new_ql),
                     snap["avg_service_time"], round(new_ar, 2)),
                )
            db.commit()
            db.close()
        except Exception:
            pass  # never crash the background thread
