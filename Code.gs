/**
 * 이수경국어 클리닉 신청 백엔드 (Google Apps Script)
 * =====================================================
 * index.html(학생 신청 폼)·teacher.html(교사용 현황) 이 JSONP 로 호출하는 웹앱입니다.
 *
 * [배포 방법]
 *   1) 신청 데이터를 쌓을 Google 스프레드시트를 열고  확장 프로그램 ▸ Apps Script  로 들어갑니다.
 *   2) 이 파일 내용을 Code.gs 에 붙여넣고, 아래 CONFIG 값을 환경에 맞게 고칩니다.
 *   3) 배포 ▸ 새 배포 ▸ 유형: 웹 앱  /  실행 사용자: 나  /  액세스: 모든 사용자
 *      → 받은 ".../exec" 주소를 index.html 의 SCRIPT_URL, teacher.html 의 DATA_URL 에 넣습니다.
 *
 * [이미 운영 중인 Code.gs 가 따로 있다면]
 *   기존 코드를 통째로 덮어쓰지 말고, 아래에서 새로 추가된 부분만 합쳐 주세요:
 *     - isOpen() / setOpen()            : 신청 받기 ON/OFF 상태 (Script Properties 에 저장)
 *     - handleStatus() / handleSetStatus(): 상태 조회·변경 액션 (status / setStatus)
 *     - handleSubmit() 의 맨 앞 isOpen() 차단 + handleSlots() 응답의 open 필드
 *   비밀번호(TEACHER_PW)·시트 이름(SHEET_NAME)·정원(SLOT_CAP)은 기존 설정과 똑같이 맞춰야 합니다.
 */

/* ===================== CONFIG ===================== */
// 컨테이너에 바인딩된 시트를 쓰면 비워 두고, 별도 시트면 스프레드시트 ID 를 넣으세요.
const SHEET_ID   = '';
// 신청 데이터가 쌓이는 시트 이름
const SHEET_NAME = '신청';
// 교사용 페이지·상태 변경에 쓰는 비밀번호 (teacher.html 에서 입력하는 값과 동일하게)
const TEACHER_PW = 'CHANGE_ME';
// 클리닉 시간대별 정원 (학생 수 기준)
const SLOT_CAP   = 9;

// 시트 헤더 순서 (1행). 기존 시트가 있다면 그 순서와 일치해야 합니다.
const HEADERS = ['제출시각', '이름', '학교', '전화뒤4', '클리닉시간', '유형', '영역', '구체내용', '질문개수', '메모'];

// 신청 받기 ON/OFF 상태 저장 키 (Script Properties)
const OPEN_KEY = 'clinicOpen';
/* ================================================= */


function doGet(e) {
  const p = (e && e.parameter) || {};
  const action = p.action || '';
  let out;
  try {
    switch (action) {
      case 'slots':     out = handleSlots();        break;
      case 'status':    out = handleStatus();       break;
      case 'setStatus': out = handleSetStatus(p);   break;
      case 'submit':    out = handleSubmit(p);      break;
      case 'data':      out = handleData(p);        break;
      default:          out = { result: 'error', message: 'unknown action' };
    }
  } catch (err) {
    out = { result: 'error', message: String(err && err.message || err) };
  }
  return reply(out, p.callback);
}

// JSONP(콜백) 또는 일반 JSON 으로 응답
function reply(obj, callback) {
  const json = JSON.stringify(obj);
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}


/* ---------- 신청 받기 ON/OFF 상태 ---------- */

// 기본값은 '열림'. 한 번도 설정하지 않았으면 신청을 받습니다.
function isOpen() {
  const v = PropertiesService.getScriptProperties().getProperty(OPEN_KEY);
  return v === null || v === '1';
}

function setOpen(open) {
  PropertiesService.getScriptProperties().setProperty(OPEN_KEY, open ? '1' : '0');
}

// action=status  →  현재 신청 받기 상태
function handleStatus() {
  return { result: 'success', open: isOpen() };
}

// action=setStatus&open=1|0&pw=...  →  상태 변경 (교사 전용)
function handleSetStatus(p) {
  if (String(p.pw || '') !== TEACHER_PW) {
    return { result: 'error', message: 'unauthorized' };
  }
  const open = (p.open === '1' || p.open === 'true');
  setOpen(open);
  return { result: 'success', open: open };
}


/* ---------- 시간대 정원 ---------- */

// action=slots  →  시간대별 신청 학생 수 + 정원 + 신청 받기 상태
function handleSlots() {
  return { result: 'success', cap: SLOT_CAP, counts: slotCounts(), open: isOpen() };
}

// 시간대별 '학생 수'(이름|학교|전화뒤4 기준 중복 제거)
function studentsBySlot() {
  const values = getSheet().getDataRange().getValues();
  const map = {};
  if (values.length < 2) return map;
  const h = values[0];
  const iTime = h.indexOf('클리닉시간');
  const iName = h.indexOf('이름');
  const iSchool = h.indexOf('학교');
  const iPhone = h.indexOf('전화뒤4');
  for (let i = 1; i < values.length; i++) {
    const time = values[i][iTime];
    if (!time) continue;
    const key = values[i][iName] + '|' + values[i][iSchool] + '|' + values[i][iPhone];
    (map[time] = map[time] || {})[key] = true;
  }
  return map;
}

function slotCounts() {
  const m = studentsBySlot();
  const out = {};
  Object.keys(m).forEach(t => { out[t] = Object.keys(m[t]).length; });
  return out;
}


/* ---------- 신청 제출 ---------- */

// action=submit&name=&school=&phone=&time=&memo=&requests=[...]
function handleSubmit(p) {
  // 신청이 중단된 상태면 제출을 막습니다.
  if (!isOpen()) return { result: 'closed' };

  const name   = String(p.name   || '').trim();
  const school = String(p.school || '').trim();
  const phone  = String(p.phone  || '').trim();
  const time   = String(p.time   || '').trim();
  const memo   = String(p.memo   || '').trim();

  if (!name || !school || !/^\d{4}$/.test(phone) || !time) {
    return { result: 'error', message: 'invalid' };
  }

  let requests = [];
  try { requests = JSON.parse(p.requests || '[]'); } catch (e) { requests = []; }
  if (!Array.isArray(requests) || requests.length === 0) {
    return { result: 'error', message: 'invalid' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // 동시 제출 사이에 닫혔을 수도 있으니 잠금 안에서 한 번 더 확인
    if (!isOpen()) return { result: 'closed' };

    const sheet = getSheet();

    // 정원 확인 (학생 수 기준). 이미 신청한 학생이 요청을 더 추가하는 건 허용.
    const slotStudents = studentsBySlot()[time] || {};
    const key = name + '|' + school + '|' + phone;
    if (!slotStudents[key] && Object.keys(slotStudents).length >= SLOT_CAP) {
      return { result: 'full', slot: time, cap: SLOT_CAP };
    }

    const ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
    const rows = requests.map(r => ([
      ts, name, school, phone, time,
      String(r.type || ''), String(r.area || ''), String(r.content || ''), String(r.count || ''), memo
    ]));
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
    return { result: 'success' };
  } finally {
    lock.releaseLock();
  }
}


/* ---------- 교사용 데이터 ---------- */

// action=data&pw=...  →  전체 신청 행 (교사 전용)
function handleData(p) {
  if (String(p.pw || '') !== TEACHER_PW) {
    return { result: 'error', message: 'unauthorized' };
  }
  const values = getSheet().getDataRange().getValues();
  if (values.length < 2) {
    return { result: 'success', rows: [], open: isOpen() };
  }
  const headers = values[0];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = values[i][j];
    rows.push(obj);
  }
  return { result: 'success', rows: rows, open: isOpen() };
}


/* ---------- 시트 핸들 ---------- */

function getSheet() {
  const ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
  }
  return sheet;
}
