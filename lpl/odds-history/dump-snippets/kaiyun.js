// Kaiyun / Yibo DJ semi-automatic odds dump.
// Usage: open the odds page, wait until markets render, paste this snippet into browser DevTools console.
// It prints normalized JSON; copy the JSON into:
//   node lpl/odds-history/collect-from-clipboard.js
(() => {
  const SOURCE = 'kaiyun_ybdj';
  const MARKET_HINTS = [
    ['map_handicap', /让图|地图让分|map\s*handicap|handicap/i],
    ['map_total', /总地图|地图总数|total\s*maps/i],
    ['total_kills', /总击杀|击杀数|kills/i],
    ['game_time', /比赛时间|游戏时间|duration|time/i],
    ['first_blood', /一血|first\s*blood/i],
    ['first_turret', /一塔|first\s*turret/i],
    ['match_win', /独赢|胜负|获胜|winner|moneyline/i],
  ];

  function allDocuments() {
    const docs = [document];
    for (const frame of document.querySelectorAll('iframe')) {
      try {
        if (frame.contentDocument) docs.push(frame.contentDocument);
      } catch {}
    }
    return docs;
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
    if (/大|over/i.test(s)) return 'over';
    if (/小|under/i.test(s)) return 'under';
    return s.replace(/\s+/g, ' ');
  }

  function extractLine(value) {
    const m = String(value || '').match(/([+-]?\d+(?:\.\d+)?)/);
    return m ? m[1] : null;
  }

  function candidateRows() {
    const rows = [];
    for (const doc of allDocuments()) {
      const nodes = [...doc.querySelectorAll('button, [role="button"], .odds, .odd, [class*="odds"], [class*="Odd"], [class*="market"], [class*="Market"]')];
      for (const node of nodes) {
        const value = text(node);
        const oddMatch = value.match(/(?:^|\s)([1-9]\d?\.\d{2,3})(?:\s|$)/);
        if (!oddMatch) continue;
        const odds = Number(oddMatch[1]);
        if (!Number.isFinite(odds) || odds <= 1 || odds > 50) continue;
        let scope = node;
        let context = value;
        for (let i = 0; i < 4 && scope?.parentElement; i += 1) {
          scope = scope.parentElement;
          context = `${text(scope)} ${context}`;
          if (detectMarket(context)) break;
        }
        const market = detectMarket(context) || 'unknown';
        const cleaned = value.replace(oddMatch[1], '').trim();
        rows.push({
          market,
          selection: normalizeSelection(cleaned || value.split(oddMatch[1])[0]),
          line: market === 'match_win' ? null : extractLine(cleaned || context),
          odds,
          raw: value,
        });
      }
    }
    return rows;
  }

  const markets = candidateRows()
    .filter((row) => row.market !== 'unknown' && row.selection && row.selection !== row.raw)
    .map(({ market, selection, line, odds }) => ({ market, selection, line, odds }));

  const title = document.title || '';
  const payload = {
    source: SOURCE,
    ts: new Date().toISOString(),
    match_name: title.replace(/\s*[-|].*$/, '') || 'PLEASE_EDIT_MATCH_NAME',
    match_start_ts: null,
    markets,
  };
  console.log(JSON.stringify(payload, null, 2));
  return payload;
})();
