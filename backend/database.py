"""
QueueAI - Database Setup and Connection
Uses SQLite for zero-config deployment (swap to PostgreSQL for production).
"""
import os
import shutil
import sqlite3
import json
from pathlib import Path
from datetime import datetime, timezone

if os.environ.get("VERCEL"):
    TMP_DB = Path("/tmp/queueai.db")
    ORIG_DB = Path(__file__).parent / "queueai.db"
    if not TMP_DB.exists() and ORIG_DB.exists():
        try:
            shutil.copy2(ORIG_DB, TMP_DB)
        except Exception:
            pass
    DB_PATH = TMP_DB
else:
    DB_PATH = Path(__file__).parent / "queueai.db"


def get_db():
    conn = sqlite3.connect(str(DB_PATH), detect_types=sqlite3.PARSE_DECLTYPES | sqlite3.PARSE_COLNAMES)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Create all tables and seed demo data."""
    conn = get_db()
    cur = conn.cursor()

    # ── Service Centres ──────────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS service_centres (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            name            TEXT    NOT NULL,
            service_type    TEXT    NOT NULL,
            location        TEXT    NOT NULL,
            operating_hours TEXT    DEFAULT '09:00-17:00',
            status          TEXT    DEFAULT 'active' CHECK(status IN ('active','inactive','maintenance')),
            created_at      TEXT    DEFAULT (datetime('now')),
            updated_at      TEXT    DEFAULT (datetime('now'))
        )
    """)

    # ── Queue Snapshots ──────────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS queue_snapshots (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            centre_id           INTEGER NOT NULL REFERENCES service_centres(id),
            timestamp           TEXT    DEFAULT (datetime('now')),
            queue_length        INTEGER NOT NULL CHECK(queue_length >= 0),
            active_counters     INTEGER NOT NULL CHECK(active_counters >= 0),
            people_being_served INTEGER DEFAULT 0 CHECK(people_being_served >= 0),
            avg_service_time    REAL    DEFAULT 5.0 CHECK(avg_service_time > 0),
            arrival_rate        REAL    DEFAULT 1.0 CHECK(arrival_rate >= 0),
            is_demo             INTEGER DEFAULT 0,
            note                TEXT
        )
    """)

    # ── Service Records ──────────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS service_records (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            centre_id               INTEGER NOT NULL REFERENCES service_centres(id),
            arrival_timestamp       TEXT    NOT NULL,
            service_start_timestamp TEXT,
            service_end_timestamp   TEXT,
            service_type            TEXT,
            actual_wait_minutes     REAL
        )
    """)

    # ── Predictions ──────────────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS predictions (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            centre_id             INTEGER NOT NULL REFERENCES service_centres(id),
            timestamp             TEXT    DEFAULT (datetime('now')),
            predicted_wait_min    REAL,
            actual_wait_min       REAL,
            prediction_method     TEXT    DEFAULT 'mathematical_baseline',
            model_version         TEXT    DEFAULT 'v1.0',
            confidence            REAL,
            lower_bound           REAL,
            upper_bound           REAL,
            congestion_status     TEXT
        )
    """)

    # ── Administrators ───────────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS administrators (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            username    TEXT    UNIQUE NOT NULL,
            password    TEXT    NOT NULL,
            role        TEXT    DEFAULT 'admin' CHECK(role IN ('superadmin','admin','viewer')),
            created_at  TEXT    DEFAULT (datetime('now')),
            last_login  TEXT
        )
    """)

    # ── Congestion Rules ─────────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS congestion_rules (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            centre_id       INTEGER REFERENCES service_centres(id),
            quiet_max_min   REAL DEFAULT 5.0,
            normal_max_min  REAL DEFAULT 15.0,
            busy_max_min    REAL DEFAULT 30.0
        )
    """)

    conn.commit()

    # ── Seed demo data if tables are empty ───────────────────────────
    existing = cur.execute("SELECT COUNT(*) FROM service_centres").fetchone()[0]
    if existing == 0:
        _seed_demo_data(conn)

    conn.close()


def _seed_demo_data(conn):
    cur = conn.cursor()

    centres = [
        ("City General Hospital",       "Hospital",         "12 Medical Drive, Northside",      "08:00-20:00", "active"),
        ("Central Bank Service Desk",   "Bank",             "5 Finance Street, City Centre",     "09:00-17:00", "active"),
        ("College Admin Office",        "Education",        "Campus Block A, University Road",   "09:00-16:00", "active"),
        ("Government Service Centre",   "Government",       "Town Hall, 1 Republic Avenue",      "09:00-17:00", "active"),
        ("Railway Ticket Counter",      "Transport",        "Central Station, Platform 1",       "06:00-22:00", "active"),
    ]
    cur.executemany(
        "INSERT INTO service_centres (name, service_type, location, operating_hours, status) VALUES (?,?,?,?,?)",
        centres
    )

    # Default admin (password: admin123 — plaintext for demo; hash in production)
    cur.execute(
        "INSERT OR IGNORE INTO administrators (username, password, role) VALUES (?,?,?)",
        ("admin", "admin123", "superadmin")
    )

    conn.commit()

    # Seed historical snapshots for analytics
    import random
    random.seed(42)
    centre_ids = [r[0] for r in cur.execute("SELECT id FROM service_centres").fetchall()]

    snapshots = []
    from datetime import timedelta

    base = datetime(2026, 10, 1, 8, 0, 0, tzinfo=timezone.utc)
    for day_offset in range(14):  # 14 days of history
        for hour in range(8, 20):
            ts = base + timedelta(days=day_offset, hours=hour - 8)
            for cid in centre_ids:
                # Realistic patterns: busy at 10-12 and 14-16
                if 10 <= hour <= 12 or 14 <= hour <= 16:
                    ql = random.randint(15, 45)
                    ac = random.randint(2, 4)
                    ast = random.uniform(4, 7)
                    ar = random.uniform(3, 6)
                elif hour < 9 or hour > 17:
                    ql = random.randint(0, 5)
                    ac = random.randint(1, 2)
                    ast = random.uniform(3, 5)
                    ar = random.uniform(0.5, 2)
                else:
                    ql = random.randint(5, 20)
                    ac = random.randint(2, 3)
                    ast = random.uniform(4, 6)
                    ar = random.uniform(1.5, 4)
                pbs = min(ac, random.randint(0, ac))
                snapshots.append((cid, ts.strftime("%Y-%m-%d %H:%M:%S"), ql, ac, pbs, ast, ar, 1))

    cur.executemany(
        "INSERT INTO queue_snapshots (centre_id, timestamp, queue_length, active_counters, people_being_served, avg_service_time, arrival_rate, is_demo) VALUES (?,?,?,?,?,?,?,?)",
        snapshots
    )

    # Set initial live state for each centre (use dynamic centre_ids)
    default_states = [
        (24, 3, 3, 5.0, 4.0),  # Hospital – moderate
        ( 6, 2, 2, 4.0, 2.0),  # Bank – quiet
        (42, 2, 2, 6.0, 5.0),  # College – very busy
        (15, 3, 3, 5.5, 3.0),  # Gov – normal
        ( 3, 4, 4, 3.0, 1.5),  # Railway – quiet
    ]
    live_states = [
        (centre_ids[i], *state, 1)
        for i, state in enumerate(default_states[:len(centre_ids)])
    ]
    cur.executemany(
        "INSERT INTO queue_snapshots (centre_id, queue_length, active_counters, people_being_served, avg_service_time, arrival_rate, is_demo) VALUES (?,?,?,?,?,?,?)",
        live_states
    )

    # Default congestion rules
    cur.executemany(
        "INSERT INTO congestion_rules (centre_id, quiet_max_min, normal_max_min, busy_max_min) VALUES (?,?,?,?)",
        [(cid, 5.0, 15.0, 30.0) for cid in centre_ids]
    )

    conn.commit()
