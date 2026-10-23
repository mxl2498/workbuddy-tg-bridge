@echo off
rem Start the bridge. Requires node in PATH (or replace "node" with an absolute path).
cd /d "%~dp0"
node bridge.js
pause
