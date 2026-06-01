@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在采集 LCK 完整公开数据和逐局页面...
npm run collect
pause
