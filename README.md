# QueueAI – AI-Powered Queue Time Prediction System

> **College-level AI Innovation Project** | Python · FastAPI · scikit-learn · SQLite · Vanilla JS

---

## 🚀 Quick Start

### 1. Install Dependencies (one-time)

```bash
python -m pip install -r requirements.txt
```

### 2. Start the Server

**Windows:**
```
Double-click start.bat
```
Or in terminal:
```bash
cd backend
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### 3. Open in Browser

```
http://localhost:8000
```

---

## 🔑 Demo Login

| Field    | Value      |
|----------|------------|
| Username | `admin`    |
| Password | `admin123` |

---

## 📁 Project Structure

```
prompt wars/
├── backend/
│   ├── main.py          ← FastAPI app + all API routes
│   ├── database.py      ← SQLite setup + demo data seeding
│   ├── predictor.py     ← ML engine (GBR + mathematical baseline)
│   └── queueai.db       ← Auto-created SQLite database
├── frontend/
│   ├── index.html       ← Single-page application
│   ├── style.css        ← Premium design system
│   └── app.js           ← All frontend logic + chart rendering
├── requirements.txt
├── start.bat
└── README.md
```

---

## 🏗️ Architecture

```
Browser (SPA)
    ↕ REST API (JSON)
FastAPI Backend (Python)
    ↕ SQL queries
SQLite Database
    ↕ DataFrame operations
Pandas + NumPy + scikit-learn
```

---

## ✨ Features

| Feature | Status |
|---------|--------|
| Live queue dashboard | ✅ |
| AI wait-time prediction | ✅ (Mathematical baseline + GBR ML) |
| Queue congestion alerts | ✅ |
| Best time to visit | ✅ |
| Service centre comparison | ✅ |
| Historical analytics + charts | ✅ |
| Secure admin panel | ✅ |
| Demo real-time simulation | ✅ |
| CSV export | ✅ |
| ML model training | ✅ |
| Mobile responsive | ✅ |

---

## 🤖 Prediction Engine

### Mathematical Baseline
```
Estimated Wait ≈ (People Waiting × Avg Service Time) ÷ Active Counters
```
Adjusted with a utilisation multiplier inspired by M/M/c queueing theory.

### ML Model (Gradient Boosting Regressor)
- **Features:** queue length, counters, service time, arrival rate, hour, day-of-week, utilisation, effective load
- **Split:** Chronological 80/20 (no future data leakage)
- **Metric:** MAE (Mean Absolute Error) in minutes
- Train from Admin → ML Models tab after data accumulates

---

## 🏥 Demo Service Centres

| # | Centre | Type |
|---|--------|------|
| 1 | City General Hospital | Hospital |
| 2 | Central Bank Service Desk | Bank |
| 3 | College Admin Office | Education |
| 4 | Government Service Centre | Government |
| 5 | Railway Ticket Counter | Transport |

> ⚠️ All demo data is **simulated and fictional**. QueueAI is not connected to any real hospital, bank, or government system.

---

## 🔌 API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /api/centres` | GET | List all service centres with live queue data |
| `GET /api/centres/{id}` | GET | Get single centre details |
| `POST /api/centres/{id}/queue` | POST | Update queue data |
| `GET /api/centres/{id}/predict` | GET | Get AI prediction |
| `GET /api/centres/{id}/best-time` | GET | Best time analysis |
| `GET /api/centres/{id}/analytics` | GET | Historical analytics |
| `GET /api/dashboard` | GET | KPI summary |
| `GET /api/alerts` | GET | Active congestion alerts |
| `POST /api/centres/{id}/train` | POST | Train ML model (admin) |
| `GET /api/admin/export/{id}` | GET | Export CSV (admin) |
| `POST /api/admin/reset-demo` | POST | Reset demo data (admin) |
| `POST /api/auth/login` | POST | Admin login |

Full interactive docs: `http://localhost:8000/api/docs`

---

## ⚠️ Important Disclaimers

- This is a **demonstration system** using **simulated data**
- Do NOT make real healthcare decisions based on QueueAI predictions
- Do NOT delay urgent medical care due to queue wait estimates
- For production use: replace SQLite with PostgreSQL, add HTTPS, hash passwords with bcrypt

---

## 🔮 Production Roadmap

1. Replace SQLite → PostgreSQL
2. Add password hashing (bcrypt)
3. Add JWT-based auth
4. Add WebSocket for instant real-time updates
5. Integrate with real queue management APIs
6. Add SMS/email notification system
7. Deploy on cloud (GCP/AWS/Azure)
