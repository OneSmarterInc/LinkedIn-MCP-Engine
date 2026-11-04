@echo off
cd /d "%~dp0"
node node_modules\tsx\dist\cli.mjs src\mcp\server.ts
