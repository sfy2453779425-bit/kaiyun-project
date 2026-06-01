# OddsPapi 免费 API 探测结论(2026-05-31)

key 鉴权: `?apiKey=<key>`(query 参数)。host: `https://api.oddspapi.io`

## 可用配方(已验证)

| 端点 | 用途 | 关键参数 |
|---|---|---|
| `/v4/sports` | 找 sportId | LoL = **18**(slug `esport-league-of-legends`) |
| `/v4/tournaments?sportId=18` | 找赛事 | LCK = tournamentId **2454**(slug `lck`) |
| `/v4/markets` | 市场 ID→名字 | 全量 3 万+,LoL(sportId 18)仅 **28 个市场** |
| `/v4/fixtures?tournamentId=2454` | 列 LCK 比赛 | 返回 264 场,fixtureId 是字符串如 `id1800245459198497`,带 `hasOdds`/`startTime`/`statusName`/队名 |
| `/v4/bookmakers` | 书商列表 | **370 家**(pinnacle/1xbet/22bet/… ;ggbet 无效) |
| `/v4/historical-odds?fixtureId=X&bookmaker=Y` | **历史赔率(带时间戳价格变动)** | 必须恰好一个 bookmaker;免费层可用 |
| `/v4/odds` | 实时赔率 | ❌ 免费层 RESTRICTED_ACCESS |

## LoL 市场 ID(historical-odds 用数字 ID,需用 /v4/markets 映射)

```
181  Winner (match_win)
183  Total Maps Over Under (map_total)
1825 / 1837  Maps Handicap (map_handicap, 多条线)
1847 First Map Winner (game1_win)
1849 Second Map Winner
```
LoL 28 个市场**全是 maps 级**,**没有总击杀/击杀让分/时长 props**。

## 限制(决定怎么用)

1. **不是回测源**:264 场只有当前 live 场 `hasOdds=true`,旧场 historical-odds 返回 404。只留近期,调不到 2024-2025。
2. **没有 props**:击杀/时长 OddsPapi 也没有,只能手贴。
3. **限流**:每端点约 1 次 / 0.75s,要节流 + 遇 `RATE_LIMITED` 按 `retryMs` 等待重试。
4. **实时赔率不开放**,但 historical-odds 含**赛前逐笔价格变动**(可取"临赛收盘价"做 CLV)。

## 采集器(已搭好)

`lck/odds-history/collect-oddspapi.js` + `oddspapi-client.js`

```
ODDSPAPI_KEY=你的key npm run odds:collect-papi
```
- 自动找当天/近期 hasOdds 的 LCK 场, 按书商优先级(pinnacle→betway→1xbet→22bet→bet365→dafabet→sbobet)抓
- 抓 match_win / game1_win / map_handicap(±1.5) / map_total(2.5) 的**收盘价**, 扣水后写
  `lck/data/odds_history/oddspapi_market_lines.csv`(含 bookmaker 列, 幂等合并)
- 队名用全名映射(Dplus→DK, Brion→BRO …), 不用 Abbr(DPL/BRI 不在别名表)
- 覆盖随书商/场次变化: 有的场只有 winner 类(如 betway 某些场), 有让分的场会自动多抓
- 限流: 每请求约 1.1s, 遇 RATE_LIMITED 按 retryMs 重试

## 怎么用(结论)

- ✅ **往前自动采集** match_win / map_handicap / map_total / game1_win:用 `/v4/fixtures` 找当天 LCK 场 → `/v4/historical-odds` 抓 pinnacle(+1xbet/22bet)的赛前价格 → 取临赛收盘价,喂"模型 vs 市场"验证。**这块不用手贴了。**
- ❌ 击杀/时长 props:OddsPapi 没有 → 仍靠手贴。
- ❌ 2024-2025 回测:OddsPapi 无深历史 → 维持 OddsPortal match_win(已用)。
