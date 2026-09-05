/* bni-hub 幹部台邏輯（LIFF，可在 LINE App 內開，也可在筆電瀏覽器透過 LINE 登入開）。
   ⚠️ 不准出現分會專屬字串，全部從 config.json／GAS 讀。
   白名單檢查只是「藏按鈕」，真正擋人是 GAS 那邊對 idToken 的驗證——UI 白名單不是安全機制本身。 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var CFG = null, IDTOKEN = null, USERID = null, CURRENT_EVENT = null, POLL_TIMER = null;

  function todayCode() {
    var d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  }

  function render(html) { $('app').innerHTML = html; }

  function run() {
    window.CHAPTER_SLUG = window.CHAPTER_SLUG || 'hongli';
    render('<div class="state"><div class="icon"><span class="spinner"></span></div><h2>讀取設定中…</h2><p></p></div>');

    Hub.loadConfig().then(function (cfg) {
      CFG = cfg;
      if (!cfg.liffId || !cfg.gasUrl) {
        render('<div class="state bad"><div class="icon">⚠</div><h2>還沒設定完成</h2><p>config.json 的 liffId／gasUrl 還沒填。</p></div>');
        return;
      }
      return liff.init({ liffId: cfg.liffId, withLoginOnExternalBrowser: true }).then(function () {
        if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; }
        return liff.getProfile().then(function (profile) {
          USERID = profile.userId;
          IDTOKEN = liff.getIDToken();
          return checkWhitelist();
        });
      });
    }).catch(function (e) {
      render('<div class="state bad"><div class="icon">⚠</div><h2>啟動失敗</h2><p>' +
        Hub.esc(e && e.message ? e.message : '不明原因') + '</p></div>');
    });
  }

  function checkWhitelist() {
    return Hub.getGas(CFG.gasUrl, { op: 'config' }).then(function (res) {
      if (!res.ok) { render(errBlock('讀取設定失敗', res.error)); return; }
      var admins = (res.config && res.config.adminUserIds) || [];
      if (admins.indexOf(USERID) === -1) {
        render('<div class="state warn"><div class="icon">🔒</div><h2>僅限幹部</h2>' +
          '<p>這個帳號不在幹部名單裡。請秘書到試算表 config 分頁把你的 LINE 帳號加進 adminUserIds。<br>' +
          '你的識別碼：<code style="font-size:11px">' + Hub.esc(USERID) + '</code></p></div>');
        return;
      }
      renderHome();
    });
  }

  function errBlock(title, err) {
    return '<div class="state bad"><div class="icon">✕</div><h2>' + Hub.esc(title) + '</h2><p>' + Hub.esc(err || '') + '</p></div>';
  }

  function renderHome() {
    render(
      '<div class="bar"><div><h1>' + Hub.esc(CFG.chapterName || '') + '｜幹部台</h1>' +
      '<div class="sub">' + Hub.esc(USERID) + '</div></div></div>' +
      '<div class="wrap" id="homeWrap"><div class="card" id="eventCard"></div><div id="listCard"></div></div>'
    );
    checkTodayEvent();
  }

  function checkTodayEvent() {
    // 用「今天日期」當事件碼的一部分去問 arrivals，藉此判斷今天有沒有已開的活動。
    // 沒有事件紀錄時 arrivals 會回「查無此活動」，這裡吃掉當作「今天還沒開」。
    var guessId = todayCode();
    Hub.getGas(CFG.gasUrl, { op: 'arrivals', e: guessId }).then(function (res) {
      if (Array.isArray(res)) {
        CURRENT_EVENT = guessId;
        renderOpenEvent();
      } else {
        renderNoEvent(guessId);
      }
    }).catch(function () { renderNoEvent(guessId); });
  }

  function renderNoEvent(suggestedId) {
    $('eventCard').innerHTML =
      '<h2 style="margin:0 0 4px;font-size:17px">今天還沒開活動</h2>' +
      '<p style="margin:0 0 14px;color:var(--muted);font-size:13px">活動碼將會是：' + Hub.esc(suggestedId) + '</p>' +
      '<button class="btn" id="openBtn">開今天例會</button>' +
      '<div class="msg" id="openMsg"></div>';
    $('listCard').innerHTML = '';
    $('openBtn').onclick = function () {
      $('openBtn').disabled = true; $('openBtn').textContent = '開啟中…';
      Hub.callGas(CFG.gasUrl, { op: 'openEvent', idToken: IDTOKEN, e: suggestedId }).then(function (res) {
        if (!res.ok) {
          $('openBtn').disabled = false; $('openBtn').textContent = '開今天例會';
          $('openMsg').className = 'msg show err'; $('openMsg').textContent = res.error || '開啟失敗';
          return;
        }
        CURRENT_EVENT = res.eventId || suggestedId;
        renderOpenEvent();
      }).catch(function (e) {
        $('openBtn').disabled = false; $('openBtn').textContent = '開今天例會';
        $('openMsg').className = 'msg show err'; $('openMsg').textContent = e.message || '網路錯誤';
      });
    };
  }

  function renderOpenEvent() {
    var checkinUrl = 'https://liff.line.me/' + CFG.liffId + '?e=' + encodeURIComponent(CURRENT_EVENT);
    $('eventCard').innerHTML =
      '<h2 style="margin:0 0 10px;font-size:17px">今天例會進行中｜活動碼 ' + Hub.esc(CURRENT_EVENT) + '</h2>' +
      '<div class="qrbox"><div id="qrHolder"></div><div class="code">請用 LINE 掃碼</div></div>' +
      '<div class="kpis" id="kpis"></div>' +
      '<div class="field"><label>補登 / 代理人 / 來賓（姓名）</label>' +
      '<div style="display:flex;gap:8px"><input type="text" id="manualName" placeholder="姓名" style="flex:1;padding:11px 13px;border:1px solid var(--line);border-radius:10px;background:var(--surface2);color:var(--text)">' +
      '<select id="manualSrc" style="border:1px solid var(--line);border-radius:10px;background:var(--surface2);color:var(--text);padding:0 8px">' +
      '<option value="manual">補登</option><option value="S">代理人</option><option value="V">來賓</option></select></div></div>' +
      '<button class="btn ghost" id="manualBtn" style="margin-bottom:8px">加入</button>' +
      '<button class="btn ghost" id="closeBtn">關閉今天例會</button>' +
      '<div class="msg" id="evMsg"></div>';
    try {
      var qr = qrcode(0, 'M');
      qr.addData(checkinUrl);
      qr.make();
      $('qrHolder').innerHTML = qr.createImgTag(5, 4);
    } catch (e) {
      $('qrHolder').innerHTML = '<p style="font-size:12px;color:var(--muted)">QR 產生失敗，可直接分享連結：<br>' + Hub.esc(checkinUrl) + '</p>';
    }

    $('manualBtn').onclick = function () {
      var name = $('manualName').value.trim();
      var src = $('manualSrc').value;
      if (!name) return;
      $('manualBtn').disabled = true;
      Hub.callGas(CFG.gasUrl, {
        op: 'checkin', idToken: IDTOKEN, e: CURRENT_EVENT,
        manual: { name: name, source: src }
      }).then(function (res) {
        $('manualBtn').disabled = false;
        var m = $('evMsg');
        if (!res.ok) { m.className = 'msg show err'; m.textContent = res.error || '加入失敗'; return; }
        $('manualName').value = '';
        m.className = 'msg show ok'; m.textContent = '已加入';
        loadArrivals();
      }).catch(function (e) { $('manualBtn').disabled = false; });
    };

    $('closeBtn').onclick = function () {
      if (!confirm('確定要關閉今天例會嗎？關閉後掃碼會顯示已截止。')) return;
      Hub.callGas(CFG.gasUrl, { op: 'closeEvent', idToken: IDTOKEN, e: CURRENT_EVENT }).then(function (res) {
        if (res.ok) { renderHome(); }
      });
    };

    loadArrivals();
    if (POLL_TIMER) clearInterval(POLL_TIMER);
    POLL_TIMER = setInterval(loadArrivals, 10000);
  }

  function loadArrivals() {
    Hub.getGas(CFG.gasUrl, { op: 'arrivals', e: CURRENT_EVENT }).then(function (list) {
      if (!Array.isArray(list)) return;
      $('kpis').innerHTML = '<div class="kpi"><div class="v">' + list.length + '</div><div class="k">已到場</div></div>';
      if (!list.length) {
        $('listCard').innerHTML = '<div class="card"><div class="empty">還沒有人報到</div></div>';
        return;
      }
      var rows = list.slice().reverse().map(function (r) {
        var badge = r.source === 'scan' ? '' :
          r.source === 'S' ? '<span class="chip warn">代理</span>' :
          r.source === 'V' ? '<span class="chip line">來賓</span>' :
          '<span class="chip line">補登</span>';
        return '<div class="att"><div class="av">' + Hub.esc((r.name || '?').slice(0, 1)) + '</div>' +
          '<div style="flex:1"><div>' + Hub.esc(r.name || '') + ' ' + badge + '</div></div>' +
          '<div class="tm">' + Hub.fmtTime(r.timestamp) + '</div></div>';
      }).join('');
      $('listCard').innerHTML = '<div class="card">' + rows + '</div>';
    });
  }

  document.addEventListener('DOMContentLoaded', run);
})();
