#!/usr/bin/env node
// 영어 회화 30분 — 매일 밤 자동화가 쓰는 도구.
// 앱(english/index.html)은 계정 없이 돌고, 끝낸 레슨 결과를 ntfy 토픽으로 보낸다.
// 이 스크립트는 그 결과를 모아(inbox), Claude가 채점한 내용을 반영하고(apply),
// 새 레슨을 검증해 추가한다(add-lesson). 자세한 절차는 english/NIGHTLY.md.
//
//   curl -sS <relay>/<topic>/json?poll=1\&since=all | node english/tools/nightly.mjs inbox -
//                                                   결과 수집 → english/.inbox/*.json
//   node english/tools/nightly.mjs brief            레슨 생성용 학습 기록 요약 출력
//   node english/tools/nightly.mjs apply <grades>   채점 반영 → profile.json, results/
//   node english/tools/nightly.mjs add-lesson <f>   새 레슨 검증·추가 → lessons/, index.json
//   node english/tools/nightly.mjs coach <f>        코치 메모 반영 {coachNote, focus, levelAdjust, levelNote}
//   node english/tools/nightly.mjs index            index.json 재생성

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const INBOX = path.join(ROOT, '.inbox');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const SKILLS = ['듣기', '어휘', '표현', '전치사·관사', '시제·동사', '공손함', '작문'];
const LEVEL_BANDS = [
  {max: 2.5, label: '입문', cefr: 'A1', guide: '문장 4~7단어, 현재형·can·want·Can I have ~?, 아주 흔한 단어만, 대화 6~8줄'},
  {max: 4.5, label: '초중급', cefr: 'A2', guide: "문장 6~12단어, 과거·미래형, Could I/Could you/I'd like, wh-질문, if possible 같은 완충 표현, 대화 8~10줄"},
  {max: 6.5, label: '중급', cefr: 'B1', guide: '문장 10~16단어, 이유·조건(because, if, so that), 흔한 구동사(check in, run out of), 의견·감상, 대화 10~12줄'},
  {max: 8.5, label: '중상급', cefr: 'B2', guide: '완곡 표현(I was wondering if, It might be better to), 뉘앙스 차이, 맥락 속 관용 표현, 대화 12~14줄'},
  {max: 99, label: '상급', cefr: 'C1', guide: '자연스러운 구어 축약·맞장구·유머, 설득과 화제 전환, 빠른 화자, 대화 12~16줄'}
];
const TOPIC_BANK = {
  '출장·여행': ['공항 체크인과 수하물', '입국 심사 질문에 답하기', '출장지 호텔 체크인과 요청', '호텔 방 문제 해결(방 교체·고장)', '택시·우버 기사에게 목적지 설명', '길 묻기·대중교통', '식당 예약 전화', '식당에서 주문하고 추천 묻기', '계산·팁·영수증 요청', '항공편 지연·변경 처리', '약국에서 증상 설명', '쇼핑과 교환·환불', '렌터카 빌리기'],
  '스몰토크·네트워킹': ['처음 만난 사람과 인사·자기소개', '내가 하는 일 쉽게 설명하기', '회사와 업계 소개하기', '날씨·여행 이야기로 대화 열기', '맞장구 치고 질문으로 대화 이어가기', '리셉션에서 대화에 끼고 자연스럽게 빠지기', '명함·연락처 주고받기', '주말·취미 이야기', '한국과 서울 소개하기', '비즈니스 디너에서 건배와 감사 인사', '다음 만남 약속과 후속 연락'],
  '와인·미식': ['와인 리스트 고르고 소믈리에에게 묻기', '와인 맛 표현(acidity·tannin·body)', '요리와 페어링 추천 받기', '와이너리 투어와 시음', '셰프에게 요리 칭찬하고 질문하기', '못 먹는 재료·알레르기 말하기', '디저트·커피 주문', '미식 이야기 스몰토크', '와인 선물 고르기']
};
const band = lv => LEVEL_BANDS.find(b => lv < b.max) || LEVEL_BANDS[LEVEL_BANDS.length - 1];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pct = v => v == null ? '–' : Math.round(v * 100) + '%';
const fmtLv = v => String(Math.round(v * 100) / 100);
const pad = n => String(n).padStart(2, '0');
function addDays(str, n) { const [y, m, d] = str.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; }
function todayKST() { const t = new Date(Date.now() + 9 * 3600e3); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; }

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, o) => { fs.mkdirSync(path.dirname(f), {recursive: true}); fs.writeFileSync(f, JSON.stringify(o, null, 1) + '\n'); };
const profilePath = path.join(DATA, 'profile.json');
const loadProfile = () => readJSON(profilePath, null) || die('profile.json 이 없어요.');
const saveProfile = p => { p.updatedAt = new Date().toISOString(); writeJSON(profilePath, p); };
const lessonPath = id => path.join(DATA, 'lessons', id + '.json');
const loadLesson = id => readJSON(lessonPath(id), null);
function allLessons() {
  const dir = path.join(DATA, 'lessons');
  return fs.readdirSync(dir).filter(f => /^L\d+\.json$/.test(f)).map(f => readJSON(path.join(dir, f))).filter(Boolean).sort((a, b) => a.seq - b.seq);
}
function die(msg) { console.error(msg); process.exit(1); }

function weakSkills(P) {
  return Object.entries(P.skillStats || {})
    .filter(([, v]) => v.n >= 1.5 && v.wrong / v.n >= 0.3)
    .sort((a, b) => b[1].wrong / b[1].n - a[1].wrong / a[1].n)
    .slice(0, 3).map(([k]) => k);
}

/* ---------- index ---------- */
function rebuildIndex() {
  const ls = allLessons().map(l => ({id: l.id, seq: l.seq, kind: l.kind, title: l.title, titleEn: l.titleEn || '', theme: l.theme, level: l.level, scene: l.scene}));
  writeJSON(path.join(DATA, 'index.json'), {updatedAt: new Date().toISOString(), lessons: ls});
  return ls;
}

/* ---------- inbox: ntfy → .inbox ---------- */
// 프록시 환경에서는 curl 로 받아 넘긴다: curl -sS "<relay>/<topic>/json?poll=1&since=all" | node nightly.mjs inbox -
async function cmdInbox(src) {
  let text;
  if (src) text = fs.readFileSync(src === '-' ? 0 : src, 'utf8');
  else {
    const res = await fetch(`${CONFIG.relay.replace(/\/$/, '')}/${CONFIG.topic}/json?poll=1&since=all`);
    if (!res.ok) die(`relay ${res.status}: ${await res.text()}`);
    text = await res.text();
  }
  const lines = text.split('\n').filter(Boolean);
  const parts = {};
  for (const line of lines) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.event !== 'message' || !ev.message) continue;
    let m; try { m = JSON.parse(ev.message); } catch { continue; }
    if (!m || typeof m.id !== 'string' || !/^[A-Za-z0-9_.:-]{3,80}$/.test(m.id)) continue;
    const of = Number(m.of) || 1, part = Number(m.part) || 0;
    if (of < 1 || of > 40 || part < 0 || part >= of || typeof m.d !== 'string') continue;
    (parts[m.id] ||= {of, chunks: {}}).chunks[part] = m.d;
  }
  const P = loadProfile();
  const done = new Set(P.processed || []);
  fs.mkdirSync(INBOX, {recursive: true});
  const got = [], skipped = [], broken = [];
  for (const [id, {of, chunks}] of Object.entries(parts)) {
    if (done.has(id)) { skipped.push(id); continue; }
    if (Object.keys(chunks).length !== of) { broken.push(`${id} (${Object.keys(chunks).length}/${of})`); continue; }
    let r; try { r = JSON.parse([...Array(of).keys()].map(i => chunks[i]).join('')); } catch { broken.push(id + ' (json)'); continue; }
    if (!r || r.id !== id || !/^L\d{3,}$/.test(r.lessonId || '') || !loadLesson(r.lessonId)) { broken.push(id + ' (형식)'); continue; }
    writeJSON(path.join(INBOX, id + '.json'), r);
    got.push(r);
  }
  got.sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
  console.log(`새 결과 ${got.length}건, 이미 반영 ${skipped.length}건, 조각 누락·형식 오류 ${broken.length}건${broken.length ? ': ' + broken.join(', ') : ''}`);
  for (const r of got) {
    const L = loadLesson(r.lessonId);
    console.log(`\n=== ${r.id} · ${r.lessonId} ${L.title} · ${r.date} · ${r.minutes}분 · 단계 ${r.stepsDone}/6`);
    console.log(`복습 ${r.review ? r.review.known + '/' + r.review.total : '–'}`);
    const items = (r.quiz && r.quiz.items) || [];
    items.forEach(x => {
      const q = L.quiz[x.i]; if (!q) return;
      if (q.type === 'produce') console.log(`  Q${x.i} 작문 「${q.prompt}」 모범답: ${q.model.en}${q.accept && q.accept.length ? ' / 다른 정답: ' + q.accept.join(' | ') : ''}\n      학습자 답: ${JSON.stringify(x.answer || '')} (자가채점 ${x.self ?? '–'})`);
      else console.log(`  Q${x.i} ${q.type} ${x.chosen === q.answer ? '정답' : '오답'}`);
    });
    const rp = r.roleplay || {};
    if (rp.turns && rp.turns.length) {
      console.log(`  롤플레이(${rp.mode}) 목표 ${(L.roleplay.goals || []).map((g, i) => `${i + 1}) ${g}`).join(' ')}`);
      rp.turns.forEach(t => { if (t.partner) console.log(`    Partner: ${t.partner}`); console.log(`    Learner: ${t.me || '(빈칸)'}`); });
      console.log(`    스스로 체크한 목표: ${(rp.goalsSelf || []).join(', ') || '없음'}`);
    } else console.log('  롤플레이 안 함');
  }
  console.log(`\n파일: ${path.relative(process.cwd(), INBOX)}/<id>.json`);
}

/* ---------- apply grades ---------- */
// grades 파일: [{id, produce: {"<quiz index>": {score 0|1|2, corrected, why, skill}}, roleplay: {rating:{accuracy,fluency,naturalness}, goalsDone:[n], good:[], corrections:[{wrong,right,why,skill}], nextTip} | null}]
function cmdApply(file) {
  const grades = readJSON(file, null);
  if (!Array.isArray(grades)) die('grades 파일은 배열이어야 해요.');
  const byId = Object.fromEntries(grades.map(g => [g.id, g]));
  const inbox = fs.existsSync(INBOX) ? fs.readdirSync(INBOX).filter(f => f.endsWith('.json')).map(f => readJSON(path.join(INBOX, f))).filter(Boolean) : [];
  inbox.sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
  let P = loadProfile();
  P.processed = P.processed || []; P.done = P.done || {};
  const report = [];
  for (const r of inbox) {
    if (P.processed.includes(r.id)) continue;
    const g = byId[r.id];
    if (!g) { console.log(`채점 없음, 건너뜀: ${r.id}`); continue; }
    const L = loadLesson(r.lessonId);
    const t = r.date || todayKST();

    // quiz
    const qItems = L.quiz.map((q, i) => {
      const x = ((r.quiz && r.quiz.items) || []).find(y => y.i === i) || {};
      if (q.type === 'produce') {
        const pg = (g.produce || {})[i] || (g.produce || {})[String(i)] || {};
        const score = [0, 1, 2].includes(Number(pg.score)) ? Number(pg.score) : [0, 1, 2].includes(x.self) ? x.self : 0;
        return {i, type: q.type, skill: SKILLS.includes(pg.skill) ? pg.skill : q.skill, score, answer: String(x.answer || ''), corrected: String(pg.corrected || ''), why: String(pg.why || ''), model: q.model.en, prompt: q.prompt};
      }
      const chosen = Number.isInteger(x.chosen) ? x.chosen : null;
      return {i, type: q.type, skill: q.skill, correct: chosen === q.answer, chosen: chosen == null ? '' : q.options[chosen], right: q.options[q.answer], explain: q.explain};
    });
    const pts = qItems.reduce((s, x) => s + (x.type === 'produce' ? x.score / 2 : (x.correct ? 1 : 0)), 0);
    const quizPct = qItems.length ? pts / qItems.length : null;
    const reviewPct = r.review && r.review.total ? r.review.known / r.review.total : null;
    const rg = g.roleplay && g.roleplay.rating;
    const rv = rg ? [rg.accuracy, rg.fluency, rg.naturalness].map(Number).filter(n => n >= 1 && n <= 5) : [];
    const rolePct = rv.length ? (rv.reduce((a, b) => a + b, 0) / rv.length - 1) / 4 : null;
    const parts = [[quizPct, 0.45], [reviewPct, 0.2], [rolePct, 0.35]].filter(([v]) => v != null && isFinite(v));
    const wsum = parts.reduce((s, [, w]) => s + w, 0);
    const composite = wsum ? parts.reduce((s, [v, w]) => s + v * w, 0) / wsum : null;
    const stepsDone = Number(r.stepsDone) || 0;
    const stepSize = L.kind === 'checkpoint' ? 0.75 : 0.25;
    let delta = 0, reason = '종합 55~85%라 레벨을 유지해요.';
    if (composite == null) reason = '점수가 없어 레벨을 유지해요.';
    else if (composite >= 0.85 && stepsDone >= 4) { delta = stepSize; reason = '종합 85% 이상이라 레벨을 올렸어요. 다음 레슨은 조금 더 길고 새 문법이 하나 들어가요.'; }
    else if (composite >= 0.85) reason = '점수는 좋았지만 6단계 중 4단계 미만을 해서 레벨은 유지해요.';
    else if (composite < 0.55) { delta = -stepSize; reason = '종합 55% 미만이라 레벨을 낮췄어요. 다음 레슨은 짧은 문장과 반복을 늘려요.'; }
    const levelBefore = P.level, levelAfter = clamp(Math.round((P.level + delta) * 4) / 4, 1, 10);

    const stats = JSON.parse(JSON.stringify(P.skillStats || {}));
    const bump = (skill, wrong) => { const s = stats[skill] || {n: 0, wrong: 0}; s.n = s.n * 0.85 + 1; s.wrong = s.wrong * 0.85 + (wrong ? 1 : 0); stats[skill] = {n: Math.round(s.n * 100) / 100, wrong: Math.round(s.wrong * 100) / 100}; };
    qItems.forEach(x => bump(x.skill, x.type === 'produce' ? x.score < 2 : !x.correct));
    const corr = ((g.roleplay && g.roleplay.corrections) || []).filter(c => c && c.right).slice(0, 5)
      .map(c => ({wrong: String(c.wrong || ''), right: String(c.right), why: String(c.why || ''), skill: SKILLS.includes(c.skill) ? c.skill : '표현'}));
    corr.forEach(c => bump(c.skill, true));
    const newMistakes = [
      ...corr.map(c => ({...c, lessonId: L.id, date: t})),
      ...qItems.filter(x => x.type === 'produce' && x.score < 2).map(x => ({wrong: x.answer, right: x.corrected || x.model, why: x.why, skill: x.skill, lessonId: L.id, date: t})),
      ...qItems.filter(x => x.type !== 'produce' && !x.correct).map(x => ({wrong: x.chosen, right: x.right, why: x.explain, skill: x.skill, lessonId: L.id, date: t}))
    ];

    const result = {
      id: r.id, lessonId: L.id, seq: L.seq, kind: L.kind, title: L.title, date: t, status: 'done',
      startedAt: r.startedAt, completedAt: r.completedAt, minutes: r.minutes, stepsDone,
      review: {total: r.review ? r.review.total : 0, known: r.review ? r.review.known : 0, pct: reviewPct},
      quiz: {pts, total: qItems.length, pct: quizPct, items: qItems},
      roleplay: {mode: (r.roleplay && r.roleplay.mode) || null, turns: (r.roleplay && r.roleplay.turns) || [], rating: rg || null,
        goalsDone: (g.roleplay && g.roleplay.goalsDone) || [], goalsTotal: (L.roleplay.goals || []).length, good: (g.roleplay && g.roleplay.good) || [], corrections: corr, nextTip: (g.roleplay && g.roleplay.nextTip) || ''},
      composite, levelBefore, levelAfter, delta, reason, gradedAt: new Date().toISOString()
    };
    writeJSON(path.join(DATA, 'results', L.id + '.json'), result);

    const prev = P.lastDoneDate;
    const firstTime = !P.done[L.id];
    P = Object.assign({}, P, {
      level: levelAfter, skillStats: stats,
      recentMistakes: [...newMistakes, ...(P.recentMistakes || [])].slice(0, 12),
      levelHistory: [...(P.levelHistory || []), {date: t, lessonId: L.id, level: levelAfter, score: composite == null ? null : Math.round(composite * 100) / 100}].slice(-60),
      streak: prev === t ? (P.streak || 1) : prev && prev > t ? (P.streak || 1) : prev === addDays(t, -1) ? (P.streak || 0) + 1 : 1,
      lastDoneDate: prev && prev > t ? prev : t,
      completed: (P.completed || 0) + (firstTime ? 1 : 0), totalMinutes: (P.totalMinutes || 0) + (Number(r.minutes) || 0),
      processed: [...P.processed, r.id].slice(-200),
      done: Object.assign({}, P.done, {[L.id]: {date: t, composite, levelAfter, resultId: r.id}})
    });
    report.push({lessonId: L.id, title: L.title, date: t, composite, quizPct, rolePct, reviewPct, levelBefore, levelAfter, reason});
    fs.rmSync(path.join(INBOX, r.id + '.json'));
    console.log(`반영: ${r.id} ${L.id} 종합 ${pct(composite)} Lv ${fmtLv(levelBefore)}→${fmtLv(levelAfter)}`);
  }
  if (report.length) P.lastReport = {date: todayKST(), items: report, note: P.lastReport && P.lastReport.date === todayKST() ? P.lastReport.note : ''};
  saveProfile(P);
  console.log(`완료: ${report.length}건 반영. 현재 Lv ${fmtLv(P.level)} (${band(P.level).label}), 약한 영역 ${weakSkills(P).join(', ') || '없음'}`);
}

/* ---------- coach note ---------- */
function cmdCoach(file) {
  const o = readJSON(file, null) || die('coach 파일을 읽지 못했어요.');
  const P = loadProfile();
  if (o.coachNote) P.coachNote = String(o.coachNote).slice(0, 600);
  if (Array.isArray(o.focus)) P.focus = o.focus.map(String).slice(0, 3);
  const adj = clamp(Number(o.levelAdjust) || 0, -0.5, 0.5);
  if (adj) { P.level = clamp(Math.round((P.level + adj) * 4) / 4, 1, 10); P.levelNote = String(o.levelNote || '').slice(0, 200); }
  if (o.reportNote != null) { P.lastReport = P.lastReport || {date: todayKST(), items: []}; P.lastReport.note = String(o.reportNote).slice(0, 600); }
  if (o.weekly) P.lastReview = todayKST();
  saveProfile(P);
  console.log('코치 메모 반영.' + (adj ? ` 레벨 보정 ${adj > 0 ? '+' : ''}${adj} → ${fmtLv(P.level)}` : ''));
}

/* ---------- brief for lesson generation ---------- */
function cmdBrief() {
  const P = loadProfile(), b = band(P.level), lessons = allLessons();
  const res = id => readJSON(path.join(DATA, 'results', id + '.json'), null);
  const upcoming = lessons.filter(l => !(P.done || {})[l.id]);
  const nextSeq = (lessons.length ? lessons[lessons.length - 1].seq : 0) + 1;
  const lastRes = lessons.slice(-4).map(l => res(l.id)).filter(Boolean).map(r =>
    `- ${r.lessonId}: 종합 ${pct(r.composite)}, 테스트 ${pct(r.quiz && r.quiz.pct)}, 롤플레이 ${r.roleplay && r.roleplay.rating ? JSON.stringify(r.roleplay.rating) : '안 함'}, 복습 ${pct(r.review && r.review.pct)}, 단계 ${r.stepsDone}/6, ${r.minutes}분`).join('\n') || '아직 없음';
  const wrongItems = lessons.slice(-3).map(l => res(l.id)).filter(Boolean).flatMap(r => ((r.quiz && r.quiz.items) || []).filter(x => x.correct === false || (x.score != null && x.score < 2)).map(x => x.skill));
  console.log(`[현황]
- 미완료 레슨 ${upcoming.length}개: ${upcoming.map(l => l.id).join(', ') || '없음'} (목표: 항상 ${CONFIG.buffer}개 유지)
- 다음에 만들 레슨 번호: ${nextSeq}부터. seq % 7 == 0 이면 주간 점검(checkpoint), 아니면 normal.

[학습자]
- 모국어 한국어. 목적: 해외 출장·여행(공항·호텔·식당·교통), 스몰토크·네트워킹(처음 만난 사람과의 대화, 리셉션·비즈니스 디너), 와인·미식(와인 리스트·소믈리에·맛 표현) 상황에서 자연스럽게 말하기.
- 현재 레벨 ${fmtLv(P.level)}/10 (${b.label}, CEFR ${b.cefr}). 이 레벨의 기준: ${b.guide}
- 최근 레슨:\n${lessons.slice(-6).map(l => `${l.seq}. ${l.title} (${l.theme}, Lv ${l.level})`).join('\n') || '없음'}
- 최근 결과:\n${lastRes}
- 약한 영역(누적): ${weakSkills(P).join(', ') || '아직 뚜렷하지 않음'} / 최근 틀린 문항 영역: ${wrongItems.join(', ') || '없음'}
- 최근 교정 노트:\n${(P.recentMistakes || []).slice(0, 10).map(m => `- ${m.wrong || '(오답)'} → ${m.right} (${m.why || ''})`).join('\n') || '없음'}
- 코치 메모: ${P.coachNote || '없음'}${(P.focus || []).length ? '\n- 이번 주 집중: ' + P.focus.join(', ') : ''}
- 직전 레슨 테마: ${(lessons[lessons.length - 1] || {}).theme || '없음'}
- 이미 한 주제: ${lessons.map(l => l.topic || l.title).join(' / ') || '없음'}
- 주간 점검이면 다시 쓸 지난 표현: ${lessons.slice(-6).flatMap(l => (l.expressions || []).map(e => e.en)).join(' / ')}

[주제 은행] ${JSON.stringify(TOPIC_BANK)}
[skill 값] ${SKILLS.join(' · ')}`);
}

/* ---------- add lesson ---------- */
function normalizeLesson(o, seq, kind, P) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('레슨 형식이 아니에요.');
  const str = v => typeof v === 'string' ? v.trim() : '';
  const tk = x => ({en: str(x && x.en), ko: str(x && x.ko)});
  const arr = v => Array.isArray(v) ? v : [];
  const errs = [];
  const quiz = arr(o.quiz).map((q, n) => {
    const t = q && q.type, skill = SKILLS.includes(q && q.skill) ? q.skill : (t === 'listen' ? '듣기' : t === 'produce' ? '작문' : '표현');
    if (['listen', 'meaning', 'blank'].includes(t)) {
      const options = arr(q.options).map(x => String(x).trim()).filter(Boolean), answer = Number(q.answer);
      if (options.length !== 4 || !Number.isInteger(answer) || answer < 0 || answer >= options.length) { errs.push(`quiz[${n}] 선택지 4개·answer 인덱스`); return null; }
      if (new Set(options).size !== 4) { errs.push(`quiz[${n}] 선택지 중복`); return null; }
      if ((t === 'listen' || t === 'blank') && !str(q.en)) { errs.push(`quiz[${n}] en 없음`); return null; }
      if (t === 'blank' && !str(q.en).includes('___')) { errs.push(`quiz[${n}] blank 에 ___ 없음`); return null; }
      if (t === 'meaning' && !str(q.prompt)) { errs.push(`quiz[${n}] prompt 없음`); return null; }
      return {type: t, en: str(q.en), ko: str(q.ko), prompt: str(q.prompt), options, answer, explain: str(q.explain), skill};
    }
    if (t === 'produce') {
      if (!str(q.prompt) || !str(q.model && q.model.en)) { errs.push(`quiz[${n}] produce prompt/model`); return null; }
      return {type: t, prompt: str(q.prompt), model: {en: str(q.model.en)}, accept: arr(q.accept).map(String), skill};
    }
    errs.push(`quiz[${n}] type`); return null;
  }).filter(Boolean);
  const rp = o.roleplay || {};
  const L = {
    id: 'L' + String(seq).padStart(3, '0'), seq, kind,
    level: Number(o.level) || P.level, theme: str(o.theme) || '여행', topic: str(o.topic) || str(o.title),
    title: str(o.title), titleEn: str(o.titleEn), scene: str(o.scene), goal: str(o.goal),
    dialogue: arr(o.dialogue).map(d => ({who: d && d.who === 'me' ? 'me' : 'partner', name: str(d && d.name) || (d && d.who === 'me' ? 'Me' : 'Partner'), nameKo: str(d && d.nameKo), ...tk(d)})).filter(d => d.en),
    expressions: arr(o.expressions).map(e => ({...tk(e), note: str(e && e.note)})).filter(e => e.en),
    grammar: {title: str(o.grammar && o.grammar.title), explain: str(o.grammar && o.grammar.explain), examples: arr(o.grammar && o.grammar.examples).map(tk).filter(e => e.en)},
    quiz,
    roleplay: {partner: str(rp.partner), partnerKo: str(rp.partnerKo), setting: str(rp.setting), goals: arr(rp.goals).map(String).slice(0, 5), opening: tk(rp.opening), mustUse: arr(rp.mustUse).map(String),
      script: arr(rp.script).map(s => ({...tk(s), hint: tk(s && s.hint)})).filter(s => s.en)},
    speaking: {task: str(o.speaking && o.speaking.task), sample: tk(o.speaking && o.speaking.sample)},
    tip: str(o.tip), createdAt: new Date().toISOString(), generatedBy: 'nightly'
  };
  const want = kind === 'checkpoint' ? 12 : 8;
  if (!L.title) errs.push('title');
  if (L.dialogue.length < 6) errs.push('dialogue 6줄 이상');
  if (L.expressions.length !== 5) errs.push('expressions 5개');
  if (quiz.length !== want) errs.push(`quiz ${want}문항 (지금 ${quiz.length})`);
  if (!L.roleplay.opening.en) errs.push('roleplay.opening');
  if (L.roleplay.goals.length < 3) errs.push('roleplay.goals 3개 이상');
  if (L.roleplay.script.length < 3) errs.push('roleplay.script 3턴 이상');
  if (!L.speaking.task) errs.push('speaking.task');
  if (errs.length) throw new Error('레슨 검증 실패: ' + errs.join(', '));
  return L;
}
function cmdAddLesson(file) {
  const o = readJSON(file, null) || die('레슨 파일을 읽지 못했어요.');
  const P = loadProfile(), lessons = allLessons();
  const seq = (lessons.length ? lessons[lessons.length - 1].seq : 0) + 1;
  const kind = seq % 7 === 0 ? 'checkpoint' : 'normal';
  let L;
  try { L = normalizeLesson(o, seq, kind, P); } catch (e) { die(e.message); }
  writeJSON(lessonPath(L.id), L);
  rebuildIndex();
  console.log(`추가: ${L.id} (${kind}) ${L.title}`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'inbox') await cmdInbox(arg);
else if (cmd === 'apply') cmdApply(arg || die('grades 파일 경로가 필요해요.'));
else if (cmd === 'add-lesson') cmdAddLesson(arg || die('레슨 파일 경로가 필요해요.'));
else if (cmd === 'coach') cmdCoach(arg || die('coach 파일 경로가 필요해요.'));
else if (cmd === 'brief') cmdBrief();
else if (cmd === 'index') console.log(rebuildIndex().length + '개 레슨');
else die('사용법: inbox | brief | apply <grades.json> | add-lesson <lesson.json> | coach <coach.json> | index');
