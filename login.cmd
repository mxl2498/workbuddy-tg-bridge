@echo off
rem One-time login: opens an interactive CodeBuddy session.
rem Type /login, finish auth in the browser, then close this window.
rem Requires: npm i -g @tencent-ai/codebuddy-code
cd /d "%~dp0"
echo.
echo  Step 1: wait for CodeBuddy to start
echo  Step 2: type /login and press Enter, finish login in browser
echo  Step 3: close this window when done
echo.
codebuddy --port 63989
pause
