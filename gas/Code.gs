/**
 * BNI 宏力會務台 —— Google Apps Script 後端。
 *
 * 部署方式：打開分會的「宏力會務台」試算表 → 擴充功能 → Apps Script → 把這份檔案整份貼進去
 * （取代預設的 Code.gs）→ 部署 → 新增部署作業 → 網頁應用程式：
 *   執行身分＝我（用分會 Google 帳號登入時按部署）
 *   誰可以存取＝任何人
 * 部署後會得到一個 https://script.google.com/macros/s/xxx/exec 網址，
 * 把它填進 chapters/hongli/config.json 的 gasUrl。
 *
 * 七個動作：bind / checkin / openEvent / closeEvent / arrivals / stats / config
 * GET  → arrivals, stats, config（唯讀，不用鎖）
 * POST → bind, checkin, openEvent, closeEvent（會寫入，一律要 idToken，寫入時上鎖）
 *
 * 第一次呼叫任何一個動作時，ensureSheets_() 會自動把六個分頁與標題列建好，
 * 不用手動先建表。
 */

var SHEETS = {
  MEMBERS: 'members',
  BINDINGS: 'bindings',
  EVENTS: 'events',
  ATTENDANCE: 'attendance',
  CONSENTS: 'consents',
  CONFIG: 'config'
};

var HEADERS = {
  members: ['memberId', 'name', 'industry', 'createdAt'],
  bindings: ['userId', 'memberId', 'name', 'industry', 'boundAt'],
  events: ['eventId', 'createdAt', 'createdBy', 'status', 'closedAt'],
  attendance: ['eventId', 'memberId', 'userId', 'name', 'source', 'timestamp'],
  consents: ['userId', 'kind', 'version', 'timestamp'],
  config: ['key', 'value', 'note']
};

// ⚠️ lineChannelId 這一格是【推論】：LINE 官方文件說 LIFF ID 的格式是「{Channel ID}-{隨機碼}」，
// 這裡先照這個格式從 LIFF ID 2011463737-i0QZU97b 取前段。若 idToken 驗證一直失敗，
// 第一件事就是來這個分頁改這一格。
var DEFAULT_CONFIG_ROWS = [
  ['chapterName', 'BNI 宏力分會', ''],
  ['orgName', 'Zense 智感資訊科技有限公司', ''],
  ['adminUserIds', '', '秘書可編輯：LINE userId，逗號分隔，幹部台的白名單（先留空，第一個幹部要用 LIFF 頁顯示出來的識別碼手動填進來）'],
  ['lineChannelId', '2011463737', '【推論，來自 LIFF ID 前段】用來驗證 idToken；若驗證一直失敗，先確認這個值對不對'],
  ['lateAfterMinutes', '', ''],
  ['closeAfterMinutes', '', ''],
  ['privacyVersion', 'v1-2026-09-06', '']
];

function ensureSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(HEADERS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.appendRow(HEADERS[name]);
      sh.setFrozenRows(1);
    } else if (sh.getLastRow() === 0) {
      sh.appendRow(HEADERS[name]);
      sh.setFrozenRows(1);
    }
  });
  var cfgSheet = ss.getSheetByName(SHEETS.CONFIG);
  if (cfgSheet.getLastRow() < 2) {
    DEFAULT_CONFIG_ROWS.forEach(function (row) { cfgSheet.appendRow(row); });
  }
  return ss;
}

function sheet_(name) {
  var ss = ensureSheets_();
  var sh = ss.getSheetByName(name);
  if (!sh) throw new Error('找不到分頁：' + name);
  return sh;
}

function readAll_(name) {
  var sh = sheet_(name);
  var values = sh.getDataRange().getValues();
  var header = values.shift() || [];
  return values.map(function (row) {
    var obj = {};
    header.forEach(function (h, i) { obj[h] = row[i]; });
    return obj;
  });
}

function appendRow_(name, obj) {
  var sh = sheet_(name);
  var header = HEADERS[name];
  var row = header.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
  sh.appendRow(row);
}

function getConfig_() {
  var rows = readAll_(SHEETS.CONFIG);
  var cfg = {};
  rows.forEach(function (r) { cfg[r.key] = r.value; });
  cfg.adminUserIds = String(cfg.adminUserIds || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  return cfg;
}

// ---- LINE idToken 驗證：呼叫 LINE 官方 verify endpoint，⛔ 不自己解 JWT 簽章 ----
function verifyIdToken_(idToken, channelId) {
  if (!idToken) throw new Error('缺少有效的 idToken');
  var resp = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: channelId },
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  var body = {};
  try { body = JSON.parse(resp.getContentText() || '{}'); } catch (e) {}
  if (code !== 200 || !body.sub) {
    throw new Error('無效的 idToken（' + (body.error_description || body.error || ('HTTP ' + code)) + '）');
  }
  return body.sub; // LINE userId
}

function findBinding_(userId) {
  var rows = readAll_(SHEETS.BINDINGS);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].userId === userId) return rows[i];
  }
  return null;
}

function nextMemberId_() {
  var rows = readAll_(SHEETS.MEMBERS);
  var max = 0;
  rows.forEach(function (r) {
    var m = /^M(\d+)$/.exec(String(r.memberId || ''));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  var n = max + 1;
  var s = String(n);
  while (s.length < 4) s = '0' + s;
  return 'M' + s;
}

function findEvent_(eventId) {
  var rows = readAll_(SHEETS.EVENTS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].eventId) === String(eventId)) return rows[i];
  }
  return null;
}

function findAttendance_(eventId, memberId) {
  var rows = readAll_(SHEETS.ATTENDANCE);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].eventId) === String(eventId) && String(rows[i].memberId) === String(memberId)) return rows[i];
  }
  return null;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  var got = lock.tryLock(10000);
  if (!got) return jsonOut_({ ok: false, error: '系統忙碌，請再試一次（鎖定逾時）' });
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ================= GET：唯讀動作 =================
function doGet(e) {
  try {
    var op = e.parameter.op;
    var cfg = getConfig_();

    if (op === 'config') {
      return jsonOut_({ ok: true, config: cfg });
    }

    if (op === 'arrivals') {
      var eventId = e.parameter.e;
      var ev = findEvent_(eventId);
      if (!ev) return jsonOut_({ ok: false, error: '查無此活動' });
      var rows = readAll_(SHEETS.ATTENDANCE).filter(function (r) { return String(r.eventId) === String(eventId); });
      var out = rows.map(function (r) {
        return { memberId: r.memberId, userId: r.userId, name: r.name, source: r.source, timestamp: r.timestamp };
      });
      // 對照組要求：查無此活動要回一個含「查無」的物件；活動存在則直接回「陣列」本身
      return jsonOut_(out);
    }

    if (op === 'stats') {
      var eventId2 = e.parameter.e;
      var ev2 = findEvent_(eventId2);
      if (!ev2) return jsonOut_({ ok: false, error: '查無此活動' });
      var rows2 = readAll_(SHEETS.ATTENDANCE).filter(function (r) { return String(r.eventId) === String(eventId2); });
      var bySource = {};
      rows2.forEach(function (r) { bySource[r.source] = (bySource[r.source] || 0) + 1; });
      return jsonOut_({ ok: true, eventId: eventId2, total: rows2.length, bySource: bySource, status: ev2.status });
    }

    return jsonOut_({ ok: false, error: '不支援的 op：' + op });
  } catch (err) {
    return jsonOut_({ ok: false, error: '伺服器錯誤：' + err.message });
  }
}

// ================= POST：會寫入資料，一律要 idToken =================
function doPost(e) {
  try {
    var body = JSON.parse((e.postData && e.postData.contents) || '{}');
    var op = body.op;
    var cfg = getConfig_();

    if (op === 'bind') return withLock_(function () { return doBind_(body, cfg); });
    if (op === 'checkin') return withLock_(function () { return doCheckin_(body, cfg); });
    if (op === 'openEvent') return withLock_(function () { return doOpenEvent_(body, cfg); });
    if (op === 'closeEvent') return withLock_(function () { return doCloseEvent_(body, cfg); });

    return jsonOut_({ ok: false, error: '不支援的 op：' + op });
  } catch (err) {
    return jsonOut_({ ok: false, error: '拒絕：' + err.message });
  }
}

function doBind_(body, cfg) {
  var userId;
  try {
    userId = verifyIdToken_(body.idToken, cfg.lineChannelId);
  } catch (err) {
    return jsonOut_({ ok: false, error: '拒絕：' + err.message });
  }
  var existing = findBinding_(userId);
  if (existing) return jsonOut_({ ok: true, alreadyBound: true, memberId: existing.memberId });

  var name = String(body.name || '').trim();
  if (!name) return jsonOut_({ ok: false, error: '缺少姓名' });
  var industry = String(body.industry || '').trim();

  var memberId = nextMemberId_();
  var now = new Date().toISOString();
  appendRow_(SHEETS.MEMBERS, { memberId: memberId, name: name, industry: industry, createdAt: now });
  appendRow_(SHEETS.BINDINGS, { userId: userId, memberId: memberId, name: name, industry: industry, boundAt: now });
  appendRow_(SHEETS.CONSENTS, { userId: userId, kind: 'notice', version: cfg.privacyVersion || '', timestamp: now });

  return jsonOut_({ ok: true, memberId: memberId });
}

function doCheckin_(body, cfg) {
  var eventId = body.e;
  var ev = findEvent_(eventId);
  if (!ev) return jsonOut_({ ok: false, error: '查無此活動' });
  if (String(ev.status) !== 'open') return jsonOut_({ ok: false, error: 'event_closed' });

  // ---- 幹部代為補登 / 代理人 / 來賓：驗的是「操作者」（幹部）身分，不是被登記者本人 ----
  if (body.manual && body.manual.name) {
    var adminId;
    try {
      adminId = verifyIdToken_(body.idToken, cfg.lineChannelId);
    } catch (err) {
      return jsonOut_({ ok: false, error: '拒絕：' + err.message });
    }
    if (cfg.adminUserIds.indexOf(adminId) === -1) {
      return jsonOut_({ ok: false, error: '拒絕：這個帳號不是幹部' });
    }
    var name = String(body.manual.name).trim();
    var source = ['manual', 'S', 'V'].indexOf(body.manual.source) !== -1 ? body.manual.source : 'manual';
    var memberId = 'ADHOC-' + Utilities.getUuid().slice(0, 8);
    appendRow_(SHEETS.ATTENDANCE, {
      eventId: eventId, memberId: memberId, userId: '', name: name, source: source,
      timestamp: new Date().toISOString()
    });
    return jsonOut_({ ok: true });
  }

  // ---- 會員本人透過 LIFF 掃碼報到 ----
  var userId;
  try {
    userId = verifyIdToken_(body.idToken, cfg.lineChannelId);
  } catch (err) {
    return jsonOut_({ ok: false, error: '拒絕：' + err.message });
  }
  var binding = findBinding_(userId);
  if (!binding) return jsonOut_({ ok: false, error: 'not_bound' });

  var already = findAttendance_(eventId, binding.memberId);
  if (already) return jsonOut_({ ok: true, duplicate: true, time: already.timestamp });

  appendRow_(SHEETS.ATTENDANCE, {
    eventId: eventId, memberId: binding.memberId, userId: userId, name: binding.name,
    source: 'scan', timestamp: new Date().toISOString()
  });
  return jsonOut_({ ok: true });
}

function doOpenEvent_(body, cfg) {
  var adminId;
  try {
    adminId = verifyIdToken_(body.idToken, cfg.lineChannelId);
  } catch (err) {
    return jsonOut_({ ok: false, error: '拒絕：' + err.message });
  }
  if (cfg.adminUserIds.indexOf(adminId) === -1) {
    return jsonOut_({ ok: false, error: '拒絕：這個帳號不是幹部（先把你的識別碼加進 config 分頁的 adminUserIds）' });
  }
  var eventId = body.e || Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd');
  var existing = findEvent_(eventId);
  if (existing) {
    if (String(existing.status) === 'open') return jsonOut_({ ok: true, eventId: eventId, alreadyOpen: true });
    return jsonOut_({ ok: false, error: '這個活動碼今天已經關閉過了' });
  }
  appendRow_(SHEETS.EVENTS, {
    eventId: eventId, createdAt: new Date().toISOString(), createdBy: adminId, status: 'open', closedAt: ''
  });
  return jsonOut_({ ok: true, eventId: eventId });
}

function doCloseEvent_(body, cfg) {
  var adminId;
  try {
    adminId = verifyIdToken_(body.idToken, cfg.lineChannelId);
  } catch (err) {
    return jsonOut_({ ok: false, error: '拒絕：' + err.message });
  }
  if (cfg.adminUserIds.indexOf(adminId) === -1) {
    return jsonOut_({ ok: false, error: '拒絕：這個帳號不是幹部' });
  }
  var sh = sheet_(SHEETS.EVENTS);
  var values = sh.getDataRange().getValues();
  var header = values[0];
  var eIdx = header.indexOf('eventId'), sIdx = header.indexOf('status'), cIdx = header.indexOf('closedAt');
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][eIdx]) === String(body.e)) {
      sh.getRange(i + 1, sIdx + 1).setValue('closed');
      sh.getRange(i + 1, cIdx + 1).setValue(new Date().toISOString());
      return jsonOut_({ ok: true });
    }
  }
  return jsonOut_({ ok: false, error: '查無此活動' });
}

/**
 * 手動執行一次即可：把 config 分頁以外的分頁設成「其他編輯者僅檢視」。
 * ⚠️ 這個函式⛔ 不會自動被呼叫——它會改變別人的編輯權限，屬於「回不去要先想清楚」的操作，
 * 交給 Ted／秘書自己決定何時執行：Apps Script 編輯器左上角函式選單選 protectDataSheets_，按執行。
 */
function protectDataSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(HEADERS).forEach(function (name) {
    if (name === SHEETS.CONFIG) return;
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    var protection = sh.protect().setDescription('僅供幹部台程式寫入，人工編輯請走幹部台功能');
    protection.removeEditors(protection.getEditors());
    if (protection.canDomainEdit()) protection.setDomainEdit(false);
  });
}
