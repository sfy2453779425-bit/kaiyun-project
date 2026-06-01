@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 只采集 LCK 赛程、队伍、选手和英雄汇总，不抓逐局页面...
npm run collect:quick
pause
