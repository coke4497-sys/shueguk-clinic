/* 클리닉 신청 확인(teacher.html) — 완료(클리어) 버튼 브라우저 E2E (2026-09-11)
 * 가짜 수파베이스(신청 원본 + 교사 인증)와 가짜 시트 백엔드(jsonp)로 실제 페이지를 띄워
 *   ① 미러로 그린 순간부터(시트 사본이 오기 전·사본에 없는 신청도) 완료 버튼이 보이는지
 *   ② 완료/미완료가 원본(clinic_requests)에 id 로 바로 PATCH 되는지
 *   ③ 시트 사본에 있는 신청만 뒤에서 setClear(jsonp)로 따라가는지
 *   ④ 학생별 보기의 묶음 버튼, ⑤ 미러 조회 실패 시 옛 경로(setClear → ts 짝 PATCH) 유지
 * 를 검사한다. 원격에는 아무것도 보내지 않는다.
 *   실행: NODE_PATH=$(npm root -g) node tools/teacher-clear-e2e.js */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const PORT = 8961, SB = 'https://bangdbhqpphqqdwcledg.supabase.co';
let n = 0, bad = 0;
const ok = (c, l) => { n++; if (!c) { bad++; console.error('  ✗', l); } else console.log('  ✓', l); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 이번 주(화~월)에 들어가는 제출시각 — 화면 기본 주차 필터가 최신 주차라서 */
const now = new Date(Date.now() + 9 * 3600e3);
const ymd = d => d.toISOString().slice(0, 10);
const TS = ymd(now) + ' 10:00';
function mkRows() {
  return [
    { id: 901, ts: TS, name: '사본있음', school: '화정고', phone: '1111', slot: '', rtype: '질문', area: '독서 · 인문', content: '비문학 3번', qcount: '', memo: '', grade: '고3', student_id: '11111111', teacher: '이수경', token: 'a', clear: '' },
    { id: 902, ts: TS, name: '사본없음', school: '가람중', phone: '2222', slot: '', rtype: '추가 문제', area: '문학 · 현대시', content: '꽃덤불', qcount: '', memo: '', grade: '중3', student_id: '22222222', teacher: '이승연', token: 'b', clear: '' },
    { id: 903, ts: TS, name: '사본없음', school: '가람중', phone: '2222', slot: '', rtype: '질문', area: '문법', content: '음운', qcount: '', memo: '', grade: '중3', student_id: '22222222', teacher: '이승연', token: 'b', clear: '' },
    { id: 904, ts: TS, name: '이미완료', school: '화정고', phone: '3333', slot: '', rtype: '질문', area: '독서 · 인문', content: 'z', qcount: '', memo: '', grade: '고3', student_id: '33333333', teacher: '이수경', token: 'c', clear: '2026-09-10 12:00' },
  ];
}
let ROWS = mkRows();
/* 시트 사본 — 901·904 만 있음(902·903 은 사본 전송이 끊긴 신청) */
function sheetRows() {
  return ROWS.filter(r => r.id === 901 || r.id === 904).map((r, i) => ({ _row: 10 + i, '제출시각': r.ts, '이름': r.name, '학교': r.school, '전화뒤4': r.phone,
    '클리닉시간': r.slot, '유형': r.rtype, '영역': r.area, '구체내용': r.content, '질문개수': r.qcount, '메모': r.memo, '학년': r.grade, '학생ID': r.student_id, '담당강사': r.teacher, '토큰': r.token, '클리어': r.clear }));
}
const patches = [], jsonps = [];
let MIRROR_FAIL = false, SHEET_DELAY = 0, HOLD = null;   // HOLD: 시트 응답을 붙들어 두는 약속(검사용)

const srv = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': p.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  res.end(fs.readFileSync(p));
});

async function route(page) {
  await page.route('**/*', async r => {
    const u = r.request().url(), m = r.request().method();
    if (u.startsWith('http://127.0.0.1:' + PORT)) return r.continue();
    if (u.startsWith(SB + '/auth/v1/token')) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ access_token: 'T', expires_in: 3600 }) });
    if (u.startsWith(SB + '/rest/v1/clinic_requests')) {
      const auth = r.request().headers()['authorization'];
      if (m === 'GET') {
        if (MIRROR_FAIL) return r.fulfill({ status: 500, body: 'x' });
        const cols = new URL(u).searchParams.get('select').split(',');
        return r.fulfill({ contentType: 'application/json', body: JSON.stringify(ROWS.map(x => { const o = {}; cols.forEach(c => { o[c] = x[c]; }); return o; })) });
      }
      if (m === 'HEAD') return r.fulfill({ status: 200, headers: { 'content-range': '0-0/' + ROWS.length }, body: '' });
      if (m === 'PATCH') {
        const q = new URL(u).searchParams, body = JSON.parse(r.request().postData() || '{}');
        let hit;
        if (q.get('id')) { const ids = q.get('id').replace(/^in\.\(|\)$/g, '').split(',').map(Number); hit = ROWS.filter(x => ids.includes(x.id)); }
        else hit = ROWS.filter(x => 'eq.' + x.ts === q.get('ts') && 'eq.' + x.name === q.get('name') && 'eq.' + x.content === q.get('content'));
        hit.forEach(x => { x.clear = body.clear; });
        patches.push({ q: u.split('?')[1], body, auth, hit: hit.map(x => x.id) });
        return r.fulfill({ contentType: 'application/json', body: JSON.stringify(hit) });
      }
    }
    if (u.startsWith(SB + '/rest/v1/clinic_settings')) return r.fulfill({ contentType: 'application/json', body: '[]' });
    if (u.startsWith('https://script.google.com/')) {
      const q = new URL(u).searchParams, cb = q.get('callback');
      jsonps.push(Object.fromEntries(q.entries()));
      if (q.get('action') === 'data') {
        if (HOLD) await HOLD;
        if (SHEET_DELAY) await sleep(SHEET_DELAY);
        return r.fulfill({ contentType: 'text/javascript', body: cb + '(' + JSON.stringify({ result: 'success', open: true, slots: [], allSlots: [], teachers: [], target: { type: '학년', target: '고3' }, rows: sheetRows() }) + ');' });
      }
      if (q.get('action') === 'setClear') {
        const rows = JSON.parse(q.get('rows')), mark = q.get('clear') === '1' ? '2026-09-11 18:00' : '';
        return r.fulfill({ contentType: 'text/javascript', body: cb + '(' + JSON.stringify({ result: 'success', mark }) + ');' });
      }
      return r.fulfill({ contentType: 'text/javascript', body: cb + '({"result":"success"});' });
    }
    return r.fulfill({ status: 204, body: '' });   // 폰트·CDN 등
  });
}
function btnOf(page, name) { return page.locator('tr', { hasText: name }).locator('.st-toggle'); }

(async () => {
  await new Promise(r => srv.listen(PORT, r));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('  [pageerror]', e.message));
  await route(page);

  console.log('① 미러로 그린 순간 — 시트 사본이 오기 전에도 버튼이 보인다');
  let release; HOLD = new Promise(r => { release = r; });
  await page.goto('http://127.0.0.1:' + PORT + '/teacher.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#list .st-toggle', { timeout: 5000 });
  ok(await page.locator('#list .clr-wait').count() === 0, '잠긴 “…” 표시가 없다');
  ok(await page.locator('#list .st-toggle').count() === 4, '네 줄 모두 완료/미완료 버튼(사본 없는 902·903 포함)');
  ok((await btnOf(page, '이미완료').textContent()).trim() === '완료', '이미 완료된 줄은 “완료”로 보인다');
  const upd = await page.locator('#updated').textContent();
  ok(upd.indexOf('원본 확인 중') >= 0, '시트 사본은 아직 확인 중 (' + upd + ')');
  release(); HOLD = null; await sleep(800);
  ok(await page.locator('#list .st-toggle').count() === 4 && await page.locator('#list .clr-wait').count() === 0, '사본이 온 뒤에도 네 줄 그대로');

  console.log('② 사본 없는 신청을 완료 — 원본 id 로 PATCH, 시트 setClear 는 보내지 않는다');
  patches.length = 0; jsonps.length = 0;
  await btnOf(page, '꽃덤불').click();
  await sleep(500);
  ok(patches.length === 1 && /id=in\.\(902\)/.test(patches[0].q), 'PATCH clinic_requests?id=in.(902)');
  ok(patches[0] && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(patches[0].body.clear), '완료 표시 = 한국시간 yyyy-MM-dd HH:mm');
  ok(patches[0] && patches[0].auth === 'Bearer T', '교사 신분으로 보낸다');
  ok(jsonps.filter(j => j.action === 'setClear').length === 0, '시트 행이 없으니 setClear 는 안 보낸다');
  ok((await btnOf(page, '꽃덤불').textContent()).trim() === '완료', '버튼이 “완료”로 바뀐다');
  ok(ROWS.find(x => x.id === 902).clear !== '' && ROWS.find(x => x.id === 903).clear === '', '같은 학생의 다른 요청(903)은 그대로');

  console.log('③ 사본 있는 신청을 완료 — 원본 PATCH + 시트 setClear 뒤따름');
  patches.length = 0; jsonps.length = 0;
  await btnOf(page, '비문학 3번').click();
  await sleep(500);
  ok(patches.length === 1 && /id=in\.\(901\)/.test(patches[0].q), 'PATCH id=in.(901)');
  const sc = jsonps.filter(j => j.action === 'setClear');
  ok(sc.length === 1 && sc[0].rows === '[10]' && sc[0].clear === '1', 'setClear rows=[10] clear=1 (시트 사본 갱신)');

  console.log('④ 다시 누르면 미완료 — clear 빈 값');
  patches.length = 0; jsonps.length = 0;
  await btnOf(page, '비문학 3번').click();
  await sleep(500);
  ok(patches.length === 1 && patches[0].body.clear === '' && /id=in\.\(901\)/.test(patches[0].q), 'PATCH clear=""');
  ok(jsonps.filter(j => j.action === 'setClear' && j.clear === '').length === 1, 'setClear clear=""');
  ok((await btnOf(page, '비문학 3번').textContent()).trim() === '미완료', '버튼이 “미완료”');

  console.log('⑤ 학생별 보기 — 묶음 버튼이 그 학생의 모든 요청 id 를 한 번에');
  patches.length = 0; jsonps.length = 0;
  await page.click('#v-stu');
  const stu = page.locator('.stu', { hasText: '사본없음' }).locator('.st-toggle');
  ok(await stu.count() === 1, '사본없음 묶음에 버튼');
  ok((await stu.textContent()).trim() === '미완료', '한 건만 완료면 묶음은 미완료');
  await stu.click(); await sleep(500);
  ok(patches.length === 1 && /id=in\.\(902,903\)/.test(patches[0].q) && patches[0].body.clear, 'PATCH id=in.(902,903)');
  ok((await page.locator('.stu', { hasText: '사본없음' }).locator('.st-toggle').textContent()).trim() === '완료', '묶음이 “완료”');
  ok(jsonps.filter(j => j.action === 'setClear').length === 0, '둘 다 시트 행이 없어 setClear 없음');

  console.log('⑥ PATCH 실패 — 화면은 그대로, 버튼이 다시 살아난다');
  await page.click('#v-req');
  await page.route(SB + '/rest/v1/clinic_requests?id=in.(904)', r => r.fulfill({ status: 500, body: 'x' }));
  page.once('dialog', d => d.dismiss());
  await btnOf(page, '이미완료').click(); await sleep(500);
  ok((await btnOf(page, '이미완료').textContent()).trim() === '완료' && !(await btnOf(page, '이미완료').isDisabled()), '실패하면 상태 그대로 + 버튼 활성');
  await page.unroute(SB + '/rest/v1/clinic_requests?id=in.(904)');

  console.log('⑦ 미러 조회 실패 — 시트만으로 그린 화면은 옛 경로(setClear → ts 짝 PATCH)');
  ROWS = mkRows(); MIRROR_FAIL = true; patches.length = 0; jsonps.length = 0;
  await page.goto('http://127.0.0.1:' + PORT + '/teacher.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#list .st-toggle', { timeout: 5000 });
  ok(await page.locator('#list .st-toggle').count() === 2, '시트 사본에 있는 두 줄만 버튼(원본 없이는 사본 기준)');
  await btnOf(page, '비문학 3번').click(); await sleep(600);
  const sc2 = jsonps.filter(j => j.action === 'setClear');
  ok(sc2.length === 1 && sc2[0].rows === '[10]', '옛 경로: setClear 먼저');
  ok(patches.length === 1 && /ts=eq\./.test(patches[0].q) && patches[0].hit.join() === '901', '그 뒤 원본에 ts·이름 짝으로 PATCH');
  ok((await btnOf(page, '비문학 3번').textContent()).trim() === '완료', '버튼 “완료”');

  await browser.close(); srv.close();
  console.log('\n' + (bad ? '✗ ' + bad + ' / ' + n + ' 실패' : '✓ ' + n + '건 모두 통과'));
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
