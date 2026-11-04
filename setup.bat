@echo off
rem One-time setup for Offline Transcriber (Windows). Needs internet;
rem nothing after this does.
rem   setup.bat           install, plus the default model (large-v3-turbo, 1.6 GB)
rem   setup.bat small     install with a smaller, faster model instead
setlocal
cd /d "%~dp0"
set "MODEL=%~1"
if "%MODEL%"=="" set "MODEL=large-v3-turbo"

set "PY="
for %%V in (3.13 3.12 3.14) do (
  if not defined PY (
    py -%%V -c "import sys" >nul 2>&1 && set "PY=py -%%V"
  )
)
if not defined PY (
  python -c "import sys; sys.exit(not (3, 12) <= sys.version_info[:2] <= (3, 14))" >nul 2>&1 && set "PY=python"
)
if not defined PY (
  echo Python 3.12, 3.13 or 3.14 is needed. Install Python 3.13 from
  echo https://www.python.org/downloads/ and run setup.bat again.
  pause
  exit /b 1
)
echo Using %PY%

if not exist ".venv\Scripts\python.exe" (
  %PY% -m venv .venv || goto :failed
)
rem Prebuilt packages only: nothing gets compiled or runs install scripts.
".venv\Scripts\python.exe" -m pip install --only-binary=:all: -r requirements.txt || goto :failed
".venv\Scripts\python.exe" download_model.py %MODEL% || goto :failed
echo.
".venv\Scripts\python.exe" -I transcriber.py check
echo.
echo Setup done. You can go offline now. Start the app with run.bat
pause
exit /b 0

:failed
echo.
echo Setup failed, see the messages above.
pause
exit /b 1
