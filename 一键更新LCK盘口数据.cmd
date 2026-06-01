@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在采集 LCK 数据并生成盘口模型...
npm run update
pause
