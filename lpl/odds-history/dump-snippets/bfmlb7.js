// bfmlb7.vip semi-automatic odds dump.
// Usage:
// 1) Open https://www.bfmlb7.vip:8000/game/gaming and navigate to the LPL market.
// 2) Wait until odds are visible.
// 3) Paste this snippet into DevTools console.
// 4) Edit match_name / match_start_ts if needed, then pipe the printed JSON into collect-from-clipboard.js.
(() => {
  const SOURCE = 'bfmlb7_vip';

  const MARKET_HINTS = [
    ['map_handicap', /让图|地图让分|局数让分|map\s*handicap|handicap/i],
    ['map_total', /总地图|地图总数|局数大小|total\s*maps/i],
    ['total_kills', /总击杀|击杀数|人头|kills/i],
    ['game_time', /比赛时间|游戏时间|时长|duration|time/i],
    ['first_blood', /一血|首杀|first\s*blood/i],
    ['first_turret', /一塔|首塔|first\s*turret/i],
    ['match_win', /独赢|胜负|获胜|赢家|winner|moneyline/i],
  ];

  function visible(el) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function text(node) {
    return (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function detectMarket(value) {
    for (const [market, re] of MARKET_HINTS) if (re.test(value)) return market;
    return '';
  }

  function normalizeSelection(value) {
    const s = String(value || '').trim();
    if (/^(大|over)$/i.test(s) || /大\s*\d|over/i.test(s)) return 'over';
    if (/^(小|under)$/i.test(s) || /小\s*\d|under/i.test(s)) return 'under';
    return s
      .replace(/[：:]/g, ' ')
      .replace(/\b\d+(?:\.\d{2,3})\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractLine(value) {
    const m = String(value || '').match(/([+-]?\d+(?:\.\d+)?)/);
    return m ? m[1] : null;
  }

  function nearestContext(node) {
    let scope = node;
    let context = text(node);
    for (let i = 0; i < 6 && scope?.parentElement; i += 1) {
      scope = scope.parentElement;
      context = `${text(scope)} ${context}`;
      if (detectMarket(context) && /\b[1-9]\d?\.\d{2,3}\b/.test(context)) break;
    }
    return context;
  }

  const nodes = [...document.querySelectorAll('button, [role="button"], div, span, li')]
    .filter(visible);
  const markets = [];
  const seen = new Set();

  for (const node of nodes) {
    const value = text(node);
    const oddMatch = value.match(/(?:^|\s)([1-9]\d?\.\d{2,3})(?:\s|$)/);
    if (!oddMatch) continue;
    const odds = Number(oddMatch[1]);
    if (!Number.isFinite(odds) || odds <= 1 || odds > 80) continue;
    const context = nearestContext(node);
    const market = detectMarket(context);
    if (!market) continue;
    const beforeOdd = value.slice(0, value.indexOf(oddMatch[1])).trim();
    const selection = normalizeSelection(beforeOdd || value);
    const line = market === 'match_win' || market === 'first_blood' || market === 'first_turret'
      ? null
      : extractLine(beforeOdd || context);
    const row = { market, selection, line, odds };
    const key = JSON.stringify(row);
    if (!selection || seen.has(key)) continue;
    seen.add(key);
    markets.push(row);
  }

  const payload = {
    source: SOURCE,
    ts: new Date().toISOString(),
    match_name: 'PLEASE_EDIT_MATCH_NAME',
    match_start_ts: null,
    markets,
  };
  console.log(JSON.stringify(payload, null, 2));
  return payload;
})();
