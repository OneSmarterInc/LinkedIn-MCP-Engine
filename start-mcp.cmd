@echo off
echo [start-mcp] launcher started, folder=%~dp0 1>&2
cd /d "%~dp0" || (echo [start-mcp] cd FAILED 1>&2 & exit /b 1)
echo [start-mcp] now in %cd% 1>&2
where node 1>&2
node node_modules\tsx\dist\cli.mjs src\mcp\server.ts