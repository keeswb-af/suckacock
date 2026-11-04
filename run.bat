@echo off
rem Start Offline Transcriber (Windows). Works without internet.
rem   run.bat                   app window
rem   run.bat record            record in this window
rem   run.bat transcribe FILE   transcribe a file
rem   run.bat check             test the privacy protections
rem   run.bat --help            everything else
if not exist "%~dp0.venv\Scripts\python.exe" (
  echo Run setup.bat first ^(one time, needs internet^).
  pause
  exit /b 1
)
rem -I: ignore PYTHON* environment variables and user packages.
"%~dp0.venv\Scripts\python.exe" -I "%~dp0transcriber.py" %*
if errorlevel 1 pause
