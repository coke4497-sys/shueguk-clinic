/**
 * 이수경국어 보충수업 신청 — Apps Script 백엔드
 *
 * ── 설치 순서 ──────────────────────────────────────────────
 * 1) 구글 스프레드시트를 새로 만들고, 주소창의 .../d/ 와 /edit 사이
 *    긴 문자열(스프레드시트 ID)을 복사해 아래 SHEET_ID 에 붙여넣으세요.
 * 2) 스프레드시트에서 [확장 프로그램] → [Apps Script] 를 열고
 *    이 코드 전체를 붙여넣고 저장하세요.
 * 3) [배포] → [새 배포] → 유형 '웹 앱' 선택
 *      - 실행 계정: 나
 *      - 액세스 권한: 모든 사용자
 *    배포 후 나오는 .../exec 주소를 복사해
 *    index.html 의 SCRIPT_URL 에 붙여넣으세요.
 * 4) 폼 항목을 바꾸면 [배포] → [배포 관리] 에서 기존 배포를
 *    '수정'해 새 버전으로 올리면 같은 주소가 유지됩니다.
 * ──────────────────────────────────────────────────────────
 *
 * ── 신청 받기 ON/OFF (중단·재개) ───────────────────────────
 * 교사용 페이지(teacher.html)의 토글 버튼이 아래 두 액션을 사용합니다.
 *   - action=status                : 현재 신청 받기 상태 조회
 *   - action=setStatus&open=1|0&pw= : 신청 받기/중단 전환 (비밀번호 필요)
 * 상태는 스프레드시트가 아니라 Script Properties 에 저장되며,
 * 중단 상태에서는 신규 신청 제출(submit)이 막힙니다.
 * ──────────────────────────────────────────────────────────
 */

var SHEET_ID = "1q-D_cGhSpVgX5epGKIVy-HH9P26ygj-TeT9yrMaHAO8";
var SHEET_NAME = "응답";

// 교사용 페이지에서 데이터를 읽을 때 요구하는 비밀번호.
// 이 값은 서버(Apps Script)에만 있고 공개 페이지에는 노출되지 않습니다.
var TEACHER_PASSWORD = "shueguk";

var HEADERS = ["제출시각", "이름", "학교", "전화뒤4", "클리닉시간", "유형", "영역", "구체내용", "질문개수", "메모"];

// 시간대(슬롯)별 신청 정원 — 학생 수 기준
var SLOT_CAP = 9;

// 신청 받기 ON/OFF 상태를 저장하는 Script Properties 키
var OPEN_KEY = "clinicOpen";

// 정원 계산에서 제외할 학생 — 다른 주 클리닉인데 같은 신청 주차 묶음에 들어온 경우.
//   - name : 학생 이름
//   - week : 신청 주차 키(그 주의 '수요일', "yyyy-MM-dd"). 생략하면 모든 주차에서 제외.
// 예) 6/17(수)에 신청했지만 6/21에 클리닉을 끝낸 두 학생을 6/24~6/28 묶음에서 빼기:
var EXCLUDE = [
  { name: "강명준", week: "2026-06-17" },
  { name: "이주원", week: "2026-06-17" }
];
function isExcluded_(name, week) {
  for (var i = 0; i < EXCLUDE.length; i++) {
    if (EXCLUDE[i].name === name && (!EXCLUDE[i].week || EXCLUDE[i].week === week)) return true;
  }
  return false;
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    return json_(handleSubmit_(data));
  } catch (err) {
    return json_({ result: "error", message: String(err) });
  }
}

// 신청 받기 상태 (기본값: 열림). 한 번도 설정하지 않았으면 신청을 받습니다.
function isOpen_() {
  var v = PropertiesService.getScriptProperties().getProperty(OPEN_KEY);
  return v === null || v === "1";
}
function setOpen_(open) {
  PropertiesService.getScriptProperties().setProperty(OPEN_KEY, open ? "1" : "0");
}

// 신청 처리 (정원 확인 후 기록). doPost·doGet 양쪽에서 사용.
function handleSubmit_(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // 신청이 중단된 상태면 제출을 막습니다.
    if (!isOpen_()) {
      return { result: "closed" };
    }

    var sheet = getSheet_();
    var nowDate = new Date();
    var nowWeek = weekKey_(nowDate);
    var slot = data.time || "";

    // 정원 확인 (같은 '주차 + 시간대'의 학생 수 기준)
    if (slot) {
      var info = slotInfo_(sheet, slot, nowWeek);
      var meKey = (data.name || "") + "|" + (data.school || "") + "|" + (data.phone || "");
      if (!info.students[meKey] && info.count >= SLOT_CAP) {
        return { result: "full", slot: slot, cap: SLOT_CAP };
      }
    }

    var now = Utilities.formatDate(nowDate, "Asia/Seoul", "yyyy-MM-dd HH:mm");
    var requests = data.requests || [];
    if (requests.length === 0) {
      requests = [{ type: "", area: "", content: "", count: "" }];
    }

    // 요청 한 건당 한 줄씩 기록
    var rows = requests.map(function (r) {
      return [
        now,
        data.name || "",
        data.school || "",
        "'" + (data.phone || ""), // 앞자리 0 보존을 위해 텍스트로 저장
        slot,
        r.type || "",
        r.area || "",
        r.content || "",
        r.count || "",
        data.memo || ""
      ];
    });

    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
    return { result: "success", saved: rows.length };
  } catch (err) {
    return { result: "error", message: String(err) };
  } finally {
    lock.releaseLock();
  }
}

// 특정 '주차 + 슬롯'에 이미 신청한 학생 집합과 인원 수
function slotInfo_(sheet, slot, week) {
  var values = sheet.getDataRange().getValues();
  var headers = values.shift() || [];
  var iT = headers.indexOf("클리닉시간"),
      iN = headers.indexOf("이름"),
      iS = headers.indexOf("학교"),
      iP = headers.indexOf("전화뒤4"),
      iD = headers.indexOf("제출시각");
  var students = {};
  values.forEach(function (r) {
    if (String(r[iT]) === slot && weekKey_(r[iD]) === week) {
      if (isExcluded_(r[iN], weekKey_(r[iD]))) return;
      students[r[iN] + "|" + r[iS] + "|" + r[iP]] = true;
    }
  });
  return { students: students, count: Object.keys(students).length };
}

// 이번 주차의 슬롯별 학생 수 (폼에서 마감 표시용)
function slotCounts_() {
  var sheet = getSheet_();
  var values = sheet.getDataRange().getValues();
  var headers = values.shift() || [];
  var iT = headers.indexOf("클리닉시간"),
      iN = headers.indexOf("이름"),
      iS = headers.indexOf("학교"),
      iP = headers.indexOf("전화뒤4"),
      iD = headers.indexOf("제출시각");
  var week = weekKey_(new Date());
  var perSlot = {};
  values.forEach(function (r) {
    var slot = String(r[iT] || ""); if (!slot) return;
    if (weekKey_(r[iD]) !== week) return;
    if (isExcluded_(r[iN], weekKey_(r[iD]))) return;
    (perSlot[slot] = perSlot[slot] || {})[r[iN] + "|" + r[iS] + "|" + r[iP]] = true;
  });
  var counts = {};
  Object.keys(perSlot).forEach(function (s) { counts[s] = Object.keys(perSlot[s]).length; });
  return counts;
}

// 제출시각을 수요일 시작 주(수~화) 단위 키("yyyy-MM-dd", Asia/Seoul)로 변환
function weekKey_(v) {
  var d = parseTs_(v);
  if (!d) return "";
  var ymd = Utilities.formatDate(d, "Asia/Seoul", "yyyy-MM-dd").split("-");
  var y = +ymd[0], mo = +ymd[1], da = +ymd[2];
  var dow = new Date(Date.UTC(y, mo - 1, da, 12)).getUTCDay(); // 0=일 .. 6=토
  var since = (dow - 3 + 7) % 7;                               // 수요일(3)로부터 지난 날 수
  var wed = new Date(Date.UTC(y, mo - 1, da - since, 12));
  return Utilities.formatDate(wed, "Asia/Seoul", "yyyy-MM-dd");
}
function parseTs_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (!v) return null;
  var s = String(v).trim();
  var d = new Date(s.indexOf("T") > -1 ? s : s.replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}

function doGet(e) {
  var params = (e && e.parameter) || {};

  // 폼: 이번 주차의 슬롯별 마감 여부 조회 (학생 수만 반환, 개인정보 없음)
  if (params.action === "slots") {
    return reply_(params.callback, { result: "success", cap: SLOT_CAP, counts: slotCounts_(), open: isOpen_() });
  }

  // 신청 받기 상태 조회
  if (params.action === "status") {
    return reply_(params.callback, { result: "success", open: isOpen_() });
  }

  // 신청 받기/중단 전환 (교사 전용)
  if (params.action === "setStatus") {
    if (params.pw !== TEACHER_PASSWORD) {
      return reply_(params.callback, { result: "error", message: "unauthorized" });
    }
    var open = (params.open === "1" || params.open === "true");
    setOpen_(open);
    return reply_(params.callback, { result: "success", open: open });
  }

  // 폼: 신청 처리 (응답을 읽어 마감 여부를 알려주기 위해 GET 사용)
  if (params.action === "submit") {
    var data = {
      name: params.name, school: params.school, phone: params.phone,
      time: params.time, memo: params.memo,
      requests: params.requests ? JSON.parse(params.requests) : []
    };
    return reply_(params.callback, handleSubmit_(data));
  }

  // 교사용 페이지의 데이터 요청
  if (params.action === "data") {
    if (params.pw !== TEACHER_PASSWORD) {
      return reply_(params.callback, { result: "error", message: "unauthorized" });
    }
    var sheet = getSheet_();
    var values = sheet.getDataRange().getValues();
    var headers = values.shift() || [];
    var rows = values.map(function (r) {
      var o = {};
      headers.forEach(function (h, i) { o[h] = r[i]; });
      return o;
    });
    return reply_(params.callback, { result: "success", rows: rows, open: isOpen_() });
  }

  return ContentService.createTextOutput("이수경국어 클리닉 수업 신청 엔드포인트가 작동 중입니다.");
}

// callback 이 있으면 JSONP(자바스크립트), 없으면 일반 JSON 으로 응답
function reply_(callback, obj) {
  var body = JSON.stringify(obj);
  if (callback) {
    return ContentService
      .createTextOutput(callback + "(" + body + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(body)
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
