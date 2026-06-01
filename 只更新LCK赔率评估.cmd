@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在根据赔率填写模板重新计算 EV...
npm run evaluate
npm run strict
pause
