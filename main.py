"""
QueueAI - Root entrypoint for Vercel and ASGI servers
Exposes the FastAPI application instance `app`.
"""
import sys
from pathlib import Path

# Ensure backend directory is in sys.path
ROOT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = ROOT_DIR / "backend"

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from backend.main import app  # noqa: F401, E402
