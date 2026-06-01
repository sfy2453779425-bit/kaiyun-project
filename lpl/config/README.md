# LPL Config

Configuration in this folder is human-maintained and should be small, explicit, and easy to audit.

## Files

| File | Purpose |
|---|---|
| `division-rating.json` | Dengfeng/Niepan group membership and display-layer cross-group rating adjustment. |

## Notes

- Config here should not silently change betting permissions.
- Betting gates belong in `lpl/odds-core.js`.
- Model fit coefficients belong in `lpl/calibration/*.json`.
- Generated reports belong in `lpl/data/盘口分析/`.
