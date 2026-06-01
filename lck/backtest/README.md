# LCK Walk-Forward Backtest

This folder contains the walk-forward backtest pipeline for the LCK market EV model.

## Data Flow

1. Collect historical tournaments with `lck/collect-lck.js`.
2. Copy each collected CSV set into `lck/data/history/<tournament_slug>/`.
3. Run `npm run backtest:collect` to merge history into:
   - `lck/data/history/all_matches.csv`
   - `lck/data/history/all_map_details.csv`
   - `lck/data/history/all_team_summary.csv`
4. Run `npm run backtest`.

The backtest uses only matches/maps before each match date. If either team has fewer than 8 prior maps, that match is skipped.
Outputs are separated by model mode: default runs write to `lck/data/backtest/legacy/`; `MODEL_MODE=new npm run backtest` writes to `lck/data/backtest/new/`.

## Commands

```powershell
npm run backtest:collect
npm run backtest:predict
npm run backtest:outcomes
npm run backtest:calibrate
npm run backtest:questions
npm run backtest:recommend
npm run backtest
```

## Outputs

- `predictions.csv`: walk-forward model probabilities before outcomes.
- `predictions_with_outcomes.csv`: predictions expanded with realized outcomes.
- `calibration_by_market.csv`: 10-bucket calibration by market.
- `calibration_by_patch.csv`: 5-bucket calibration by market and patch.
- `brier_scores.csv`: Brier score and skill by market.
- `version_sensitivity.csv`: patch-change 0-14 day vs stable-period comparison.
- `total_kills_roi.csv`: total_kills line/side ROI under a 5% vig assumption.
- `三个问题答案.md`: direct answers to the three requested questions.
- `模型修正建议.md`: actionable model adjustment recommendations.

## Notes

For strict walk-forward behavior, `backtest-predict.js` strips season-summary metrics before calling `buildProfiles`. This avoids using full-season summary data from after the cutoff date. The current production model can still use summaries normally.
