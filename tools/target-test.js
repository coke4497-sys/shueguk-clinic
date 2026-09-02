#!/usr/bin/env node
/* 클리닉 신청 대상 판정 검증 — node tools/target-test.js
 * 배정이 '기존 대상에 더하기'로 바뀌면서 한 대상에 학년 토큰과 이름 토큰이 섞일 수 있다.
 * Code.gs(백엔드) · s.html(학생 페이지 이식본) · clinic_assign.html(합치기)이
 * 같은 규칙으로 읽는지 세 벌을 모두 떼어 대조한다. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const REPORT = path.join(ROOT, '..', 'shueguk-report');

/* 파일에서 함수 선언을 이름으로 떼어 온다 (중괄호 짝 맞추기) */
function grab(src, name){
  const re = new RegExp('\\n[ \\t]*function ' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error(name + ' 함수를 찾지 못했습니다');
  const at = m.index;
  let i = src.indexOf('{', at), depth = 0, j = i;
  for (; j < src.length; j++){
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}'){ depth--; if (!depth) break; }
  }
  return src.slice(at, j + 1);
}
function run(src, names, tail){
  const ctx = { console }; vm.createContext(ctx);
  vm.runInContext(names.map(n => grab(src, n)).join('\n') + '\n' + tail, ctx);
  return ctx;
}

const GS = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
const back = run(GS, ['gradeKey_', 'schoolLoose_', 'isGradeToken_', 'eligibleForTarget_', 'gradeTokensOf_'],
  ';globalThis.__b = { ok: eligibleForTarget_, grades: gradeTokensOf_ };').__b;

const SH = fs.readFileSync(path.join(REPORT, 's.html'), 'utf8');
// s.html 이식본은 tr()·schoolMatch()를 쓴다 — 원본에서 같이 떼어 온다
const front = run(SH, ['tr', 'schoolMatch', 'clinicGradeKey', 'clinicGradeTok', 'clinicEligible'],
  ';globalThis.__f = clinicEligible;').__f;

const CA = fs.readFileSync(path.join(ROOT, 'clinic_assign.html'), 'utf8');
const merge = run(CA, ['tokensOf', 'isGradeTok', 'mergeTarget', 'targetCount'],
  ';globalThis.__m = { merge: mergeTarget, count: targetCount, isG: isGradeTok };').__m;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + extra : '')); } };
/* 백엔드와 학생 페이지가 같은 답을 내는지 함께 본다 (s.html은 tr/schoolMatch를 쓰므로 스텁 주입) */
function both(sel, stu){
  const b = back.ok(sel, stu);
  const f = front(sel, stu);
  ok('백엔드=학생페이지 (' + (sel.target || sel.type) + ' / ' + stu.name + ')', b === f, 'back=' + b + ' front=' + f);
  return b;
}
const 고3 = { name: '김은수', school: '무원고', grade: '2026 고등 3학년' };
const 중3 = { name: '천예원', school: '화정중', grade: '2026 중등 3학년' };
const 고2 = { name: '박준호', school: '화수고', grade: '2026 고등 2학년' };

/* 1) 옛 데이터 그대로 (회귀) */
ok('전체 대상', both({ type:'전체', target:'' }, 고3) === true);
ok('학년 대상 — 고3 통과', both({ type:'학년', target:'2026 고등 3학년' }, 고3) === true);
ok('학년 대상 — 고2 차단', both({ type:'학년', target:'2026 고등 3학년' }, 고2) === false);
ok('학년 대상 — 중3 차단(중·고 구분)', both({ type:'학년', target:'2026 고등 3학년' }, 중3) === false);
ok("공통 대상 '고3' 표기", both({ type:'학년', target:'고3' }, 고3) === true);
ok('일부 대상 — 이름 통과', both({ type:'일부', target:'천예원, 정수빈' }, 중3) === true);
ok('일부 대상 — 이름 없음', both({ type:'일부', target:'정수빈' }, 중3) === false);
ok('동명이인 토큰 — 학교 일치', both({ type:'일부', target:'천예원|화정중|중3' }, 중3) === true);
ok('동명이인 토큰 — 학교 다름', both({ type:'일부', target:'천예원|백석중|중3' }, 중3) === false);

/* 2) 섞인 대상 (더하기로 생기는 모양) */
const MIX = { type:'일부', target:'2026 고등 3학년, 천예원, 정수빈' };
ok('섞인 대상 — 고3 학생 통과', both(MIX, 고3) === true);
ok('섞인 대상 — 이름 학생 통과', both(MIX, 중3) === true);
ok('섞인 대상 — 해당 없음 차단', both(MIX, 고2) === false);
ok('섞인 대상 — 학년으로 폼을 막지 않음', back.grades(MIX) === null, JSON.stringify(back.grades(MIX)));
ok('순수 학년 대상은 폼 학년 제한 유지', JSON.stringify(back.grades({ type:'학년', target:'2026 고등 3학년' })) === '["고3"]',
   JSON.stringify(back.grades({ type:'학년', target:'2026 고등 3학년' })));

/* 3) 합치기 규칙 */
let m = merge.merge({ type:'일부', target:'김민성, 김주언' }, { type:'개인', target:'천예원' });
ok('더하기 — 이름 추가', m.target === '김민성, 김주언, 천예원' && m.type === '일부' && m.added === 1, JSON.stringify(m));
m = merge.merge({ type:'일부', target:'김민성, 천예원' }, { type:'개인', target:'천예원' });
ok('더하기 — 이미 있으면 그대로', m.target === '김민성, 천예원' && m.added === 0, JSON.stringify(m));
m = merge.merge({ type:'학년', target:'2026 고등 3학년' }, { type:'개인', target:'천예원' });
ok('더하기 — 학년+이름은 섞임 표시', m.mixed === true && m.type === '일부' && m.target === '2026 고등 3학년, 천예원', JSON.stringify(m));
ok('섞인 결과를 백엔드가 읽음', back.ok({ type:m.type, target:m.target }, 고3) === true && back.ok({ type:m.type, target:m.target }, 중3) === true);
m = merge.merge({ type:'학년', target:'고1' }, { type:'학년', target:'고2, 고1' });
ok('더하기 — 학년끼리', m.type === '학년' && m.target === '고1, 고2' && m.mixed === false, JSON.stringify(m));
m = merge.merge({ type:'전체', target:'' }, { type:'개인', target:'천예원' });
ok('기존이 전 학년이면 그대로', m.type === '전체' && m.keptAll === true, JSON.stringify(m));
m = merge.merge({ type:'일부', target:'김민성' }, { type:'전체', target:'' });
ok('전 학년을 더하면 전 학년', m.type === '전체', JSON.stringify(m));
m = merge.merge(null, { type:'일부', target:'김민성, 천예원' });
ok('기존 대상이 없으면 새 선택 그대로', m.target === '김민성, 천예원' && m.added === 2, JSON.stringify(m));

/* 4) 표시 문구 */
ok('표시 — 이름만', merge.count({ type:'일부', target:'가, 나, 다' }) === '3명', merge.count({ type:'일부', target:'가, 나, 다' }));
ok('표시 — 학년+이름', merge.count({ type:'일부', target:'2026 고등 3학년, 천예원' }) === '2026 고등 3학년 + 1명',
   merge.count({ type:'일부', target:'2026 고등 3학년, 천예원' }));
ok('표시 — 전 학년', merge.count({ type:'전체', target:'' }) === '전 학년');
ok('표시 — 설정 없음', merge.count(null) === '설정 없음');
ok('학년 토큰 판정', merge.isG('고3') && merge.isG('2026 중등 3학년') && !merge.isG('천예원') && !merge.isG('김삼학'),
   [merge.isG('고3'), merge.isG('2026 중등 3학년'), merge.isG('천예원'), merge.isG('김삼학')].join(','));

console.log((fail ? '✗' : '✓') + ' ' + pass + '건 통과' + (fail ? ' / ' + fail + '건 실패' : ''));
process.exit(fail ? 1 : 0);
