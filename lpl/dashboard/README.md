# LPL Team Model Studio

This is a Windows local dashboard for the LPL team model. It uses PowerShell WPF, so it does not require a browser or a dev server.

## Start

```powershell
npm run lpl:dashboard
```

Or double-click:

```text
lpl\dashboard\start-dashboard.cmd
```

Smoke test without opening the window:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File lpl/dashboard/lpl-dashboard.ps1 -SmokeTest
```

UI smoke test without showing the window:

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File lpl/dashboard/lpl-dashboard.ps1 -UiSmokeTest
```

Show the window and auto-close it:

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File lpl/dashboard/lpl-dashboard.ps1 -UiShowSmokeTest
```

## What It Reads

- `lpl/data/盘口分析/队伍盘口命中率.csv`
- `lpl/data/盘口分析/队伍模型洞察.json`
- `lpl/data/盘口分析/队伍模型洞察.csv`
- `lpl/data/lpl_map_details.csv`
- `lpl/data/lpl_player_map_details.csv`

The dashboard shows model internals: team rating, style, confidence, attack, defense, early game, objective control, volatility, recent maps, and hero-pool snapshots.

It is not a bet picker. Betting still goes through `odds-core.js`, odds evaluation, strict filtering, and bankroll rules.
