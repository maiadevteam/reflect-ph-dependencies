@echo off
cd /d "%~dp0"
:: Check if Node.js is installed
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo Node.js is not installed. Installing Node.js...
    start /wait "" "node-v20.15.0-x64.msi"
    echo Node.js installation complete.
)
:: Run npm install and start the development server
start cmd /k "npm install && npm run dev"
