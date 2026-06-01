# Claude Code 交接 Prompt

> 直接把下面"=== Prompt 开始 ==="到"=== Prompt 结束 ==="之间的内容贴给 Claude Code 即可。

---

=== Prompt 开始 ===

我有一个 LCK / LPL 比赛盘口 EV 分析工具（Node 20，纯 JS，无 TS），路径是当前工作目录。结构如下：

```
lck/   # LCK 赛区一整套：collect / build-market-analysis / evaluate-odds / strict-filter / evaluate-hero-markets / odds-core / shared / backtest/*
lpl/   # LPL 赛区一整套，文件名几乎和 lck/ 镜像
package.json  # scripts 已经把所有命令配好，分 lck:* 和 lpl:* 两套
README.md
```

**硬约束（非常重要，不要违反）：**

LCK 和 LPL 是两个独立系统，不要抽公共 `core/`、不要合并 `odds-core.js` / `shared.js` / `backtest/*`、不要参数化成一个引擎。两个赛区的数据源、队伍画像、剧本节奏参数、baseline 都是独立的，合并会扩大调参的爆炸半径。哪怕两边代码看起来 90% 一样，也分别在 `lck/` 和 `lpl/` 各做一遍，不要 import 对方的文件。

如果同一个改动需要在两边都落地，先在 `lck/` 写完跑通，再去 `lpl/` 独立写一遍（可以参考 lck 的实现思路，但不复用代码）。

---

## 任务

请按顺序做两件事，每件都先在 lck/ 跑通验证，再去 lpl/ 独立实现一遍。

### 任务 1：阈值从回测里反推，主流程读 JSON

**现状：** `lck/odds-core.js` 的 `preliminaryGrade` 里有一堆硬编码阈值：

```js
if (sample > 0 && sample < 8) ...                                    // 样本下限
if (meta.volatility === 'high' && evValue < 0.18) ...                // 高波动盘 EV 下限
if (edge >= 0.08 && evValue >= 0.12 && sample >= 16 ...) // A 档    // A 档门槛
if (edge >= 0.03 && evValue > 0 ...) // B 档                         // B 档门槛
```

这些数字写死后没法迭代。

**要做的：**

1. 在 `lck/backtest/backtest-calibrate.js` 里加一段逻辑：基于历史回测数据，对若干阈值组合（edge 门槛、ev 门槛、sample 门槛、高波动 ev 门槛）做网格搜索，按 ROI 和命中率与模型预测的一致性（建议用 Brier score 或简单的分桶校准误差）联合打分，挑出最好的一组。

2. 把结果输出到 `lck/data/calibration/recommended_thresholds.json`，结构大致是：

   ```json
   {
     "generated_at": "2026-05-21T...",
     "based_on_samples": 1234,
     "thresholds": {
       "min_sample": 8,
       "high_volatility_min_ev": 0.18,
       "a_grade": { "min_edge": 0.08, "min_ev": 0.12, "min_sample": 16 },
       "b_grade": { "min_edge": 0.03, "min_ev": 0 }
     },
     "expected_roi_a": 0.xx,
     "expected_roi_b": 0.xx
   }
   ```

3. 改 `lck/odds-core.js` 的 `preliminaryGrade`：启动时尝试读这个 JSON，读到就用 JSON 里的值，读不到（首次运行、文件缺失）就 fallback 到当前硬编码值。fallback 值原封不动保留作为 default，不要删。

4. 不要破坏现有 `npm run lck:backtest` 流程；新逻辑作为 calibrate 的额外产物输出即可。

**验证：** 跑一次 `npm run lck:backtest`，确认 `lck/data/calibration/recommended_thresholds.json` 生成、内容合理；再跑 `npm run lck:markets` 或 `npm run lck:evaluate`，确认主流程能读到新阈值（可以在 odds-core 加一行 console.log 标明用的是 calibrated 还是 default，验证完留着也行）。

跑通之后，在 `lpl/` 独立再写一份对应的逻辑，输出到 `lpl/data/calibration/recommended_thresholds.json`，改 `lpl/odds-core.js`。不要 import lck 的任何东西。

---

### 任务 2：推荐 → 结果 journal

**现状：** 每次 `npm run lck:update` 跑完，`lck/data/盘口分析/` 会被覆盖，没有长期记录。无法回答"过去 30 天 A 档实际命中率"。

**要做的：**

1. 新增 `lck/data/journal.csv`，列建议：

   ```
   snapshot_date, match_id, match_name, scheduled_at,
   market, selection, line, side,
   odds_filled, implied_prob, model_prob, edge, ev, sample,
   risk_grade, suggested_stake, scenario,
   actual_result, settled_at, profit
   ```

2. 在 `lck/strict-filter.js` 或合适的位置加一步：每次跑完，把当前 `可下注候选.csv` 里的行追加到 `journal.csv`，用 `(snapshot_date, match_id, market, selection, line, side)` 做幂等键去重（同一天同一场同一盘只记一次最新状态）。`actual_result / settled_at / profit` 先留空。

3. 新增一个脚本 `lck/backfill-journal-results.js`：读 `journal.csv` 里 `actual_result` 为空的行，对比 `lck_matches.csv` / `lck_map_details.csv` 里已结束比赛的实际数据，能判定的就回填胜负和盈亏，判不了的（盘口逻辑复杂、数据缺失）留空并打 tag。`package.json` 加一条 `"lck:journal": "node lck/backfill-journal-results.js"`。

4. 再加一个轻量统计脚本 `lck/journal-report.js`：读 `journal.csv`，按 `risk_grade` 分组统计命中率、平均 EV、累计 ROI，输出到 `lck/data/journal_report.md`。`package.json` 加 `"lck:journal:report": "node lck/journal-report.js"`。

**验证：** 跑 `npm run lck:update` 一次，看 `journal.csv` 有没有正常追加；跑 `npm run lck:journal` 回填一次，看历史数据有没有结果列；跑 `npm run lck:journal:report` 看汇总。

跑通后，同样在 `lpl/` 独立再做一份：`lpl/data/journal.csv`、`lpl/backfill-journal-results.js`、`lpl/journal-report.js`、`lpl/data/journal_report.md`、对应的 `lpl:journal` / `lpl:journal:report` 命令。

---

## 其它约束

- 文件 IO 用项目里已有的 `shared.js` 工具（`readCsv` / `writeCsv` / `toCsv`），不要引新依赖。
- `package.json` 现在是 `"private": true`，不要加 dependencies；如果非要新包，先停下来问我。
- 不要改两个赛区已有的命令行接口（`npm run lck:*`、`npm run lpl:*` 现有行为保持），只能新增。
- 改完每一步用 `git diff` 自查一下没有跨目录引用（`lck/` 文件不应 import `lpl/` 的东西，反之亦然）。

先做 lck 任务 1，跑通验证后再做 lck 任务 2，最后镜像到 lpl。每个大节点结束停下来跟我同步进度。

=== Prompt 结束 ===

---

## 使用建议

- 在 Claude Code 里 `cd` 到项目根目录后再粘贴，这样它能直接 `ls` / 读文件。
- 如果它一上来就想抽公共层、或者跨目录 import，立刻打断并指回 prompt 里的"硬约束"段落。
- 任务 1 跑完先停一下看结果再让它做任务 2，避免一口气改太多不好回滚。
