@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing Relay...
  npm install
  if errorlevel 1 exit /b 1
)
npm start
