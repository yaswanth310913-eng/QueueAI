@echo off
echo ============================================
echo   QueueAI - AI-Powered Queue Time Prediction
echo ============================================
echo.
echo Starting backend server...
echo.
cd /d "%~dp0backend"
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
