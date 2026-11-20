// 대한항공 2026-11-29 CJU→GMP 성인 2명 감시 (Google 항공편 기준)
// 사용: node flight-watch/watch.js  → 현재 결과 출력 + 이전 상태와 비교
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const STATE = path.join(__dirname, 'state.json');
const URL = 'https://www.google.com/travel/flights?q=Flights%20from%20CJU%20to%20GMP%20on%202026-11-29%20one%20way%202%20adults%20Korean%20Air&hl=ko&curr=KRW';

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ locale: 'ko-KR' });
  await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(15000);
  const more = p.getByText(/항공편 더보기|more flights/i).first();
  if (await more.count()) { await more.click().catch(() => {}); await p.waitForTimeout(4000); }
  const text = await p.innerText('body');
  await b.close();

  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  const flights = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^(오전|오후) \d{1,2}:\d{2}$/.test(lines[i]) && lines[i + 1] === '–' && /^(오전|오후)/.test(lines[i + 2] || '')) {
      const block = lines.slice(i, i + 14);
      const price = block.find(s => /^₩[\d,]+$/.test(s));
      const airline = lines[i + 3];
      if (/대한항공/.test(airline)) flights.push({ dep: lines[i], arr: lines[i + 2], price: price || '가격없음/매진' });
    }
  }
  const uniq = [...new Map(flights.map(f => [f.dep, f])).values()];
  if (!uniq.length) { console.log(JSON.stringify({ error: 'no results parsed', head: lines.slice(0, 40) })); process.exit(2); }

  const prev = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null;
  const changes = [];
  if (prev) {
    const pm = new Map(prev.flights.map(f => [f.dep, f]));
    const nm = new Map(uniq.map(f => [f.dep, f]));
    for (const f of uniq) {
      if (!pm.has(f.dep)) changes.push(`신규 노출: ${f.dep}→${f.arr} ${f.price}`);
      else if (pm.get(f.dep).price !== f.price) changes.push(`가격 변동: ${f.dep} ${pm.get(f.dep).price} → ${f.price}`);
    }
    for (const f of prev.flights) if (!nm.has(f.dep)) changes.push(`사라짐(매진 가능): ${f.dep}→${f.arr}`);
  }
  fs.writeFileSync(STATE, JSON.stringify({ checkedAt: new Date().toISOString(), flights: uniq }, null, 2));
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), firstRun: !prev, changes, flights: uniq }, null, 2));
})();
