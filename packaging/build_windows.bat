@echo off
REM Baut Distrimatcher als Windows-Programm (Ordner dist\Distrimatcher mit Distrimatcher.exe).
REM Voraussetzung: Python 3.11+ (python.org), optional Tesseract unter packaging\tesseract
cd /d %~dp0\..
python -m venv .venv || goto :err
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements-dev.txt || goto :err
python -m pytest -q || goto :err
pyinstaller --noconfirm packaging\distrimatcher.spec || goto :err
echo.
echo Fertig: dist\Distrimatcher\Distrimatcher.exe
goto :eof
:err
echo Build fehlgeschlagen.
exit /b 1
