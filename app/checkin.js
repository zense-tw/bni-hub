/* bni-hub 會員簽到頁邏輯（LIFF）。⚠️ 不准出現分會專屬字串，全部從 config.json 讀。
   流程：liff.init → 拿 idToken → 先試 checkin → 沒綁定就先顯示「姓名＋行業別」表單 → bind → 再 checkin。 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var CFG = null;

  function showState(kind, iconHtml, title, sub) {
    $('app').innerHTML =
      '<div class="state ' + kind + '"><div class="icon">' + iconHtml + '</div>' +
      '<h2>' + title + '</h2><p>' + (sub || '') + '</p></div>';
  }

  function showLoading(text) {
    $('app').innerHTML = '<div class="state"><div class="icon"><span class="spinner"></span></div>' +
      '<h2>' + (text || '處理中…') + '</h2><p></p></div>';
  }

  function showForm(eventId, onSubmit) {
    $('app').innerHTML =
      '<div class="card">' +
      '<h1 style="margin:0 0 4px;font-size:18px">第一次報到，先留一下資料</h1>' +
      '<p style="margin:0 0 16px;color:var(--muted);font-size:13px">30 秒填完，之後掃碼直接報到</p>' +
      '<div class="notice" id="noticeText"></div>' +
      '<div class="field"><label>姓名</label><input type="text" id="fName" placeholder="請輸入姓名"></div>' +
      '<div class="field"><label>行業別</label><input type="text" id="fIndustry" placeholder="例：保險、房仲、資訊服務"></div>' +
      '<button class="btn" id="submitBtn">送出並完成報到</button>' +
      '<div class="msg" id="formMsg"></div>' +
      '</div>';
    $('noticeText').innerHTML = CFG.privacyNoticeHtml || '';
    $('submitBtn').onclick = function () {
      var name = $('fName').value.trim();
      var industry = $('fIndustry').value.trim();
      var msgEl = $('formMsg');
      if (!name) {
        msgEl.className = 'msg show err'; msgEl.textContent = '請填姓名';
        return;
      }
      $('submitBtn').disabled = true; $('submitBtn').textContent = '送出中…';
      onSubmit(name, industry, function (errText) {
        $('submitBtn').disabled = false; $('submitBtn').textContent = '送出並完成報到';
        msgEl.className = 'msg show err'; msgEl.textContent = errText;
      });
    };
  }

  function run() {
    window.CHAPTER_SLUG = window.CHAPTER_SLUG || 'hongli';
    showLoading('讀取設定中…');

    Hub.loadConfig().then(function (cfg) {
      CFG = cfg;
      if (!cfg.liffId) {
        showState('bad', '⚠', '還沒設定完成', 'LIFF ID 還沒填進 config.json。');
        return;
      }
      if (!cfg.gasUrl) {
        showState('bad', '⚠', '還沒設定完成', '後端網址（gasUrl）還沒填進 config.json。');
        return;
      }
      CFG.privacyNoticeHtml = CFG.privacyNoticeHtml ||
        ('（' + Hub.esc(cfg.chapterName || '') + '，資料由 ' + Hub.esc(cfg.orgName || '') +
         ' 代為處理）為辦理會務蒐集您的姓名、LINE 帳號識別碼與出席紀錄，僅供本分會幹部於您在會期間內查閱與統計使用。' +
         '詳細告知事項請見 <a href="' + Hub.esc(cfg.privacyUrl || '') + '" target="_blank" rel="noopener">個資告知頁</a>。');

      return liff.init({ liffId: cfg.liffId, withLoginOnExternalBrowser: true }).then(function () {
        var q = Hub.parseQuery();
        var eventId = q.get('e');
        if (!eventId) {
          showState('bad', '✕', '缺少活動代碼', '請用幹部台螢幕上的 QR 碼掃描進入，不要直接打開這個網址。');
          return;
        }

        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: location.href });
          return;
        }

        showLoading('確認身分中…');
        return liff.getIDToken() ? Promise.resolve(liff.getIDToken()) : Promise.reject(new Error('拿不到身分憑證'));
      }).then(function (idToken) {
        if (!idToken) return;
        return attemptCheckin(cfg, idToken, new URLSearchParams(location.search).get('e') || Hub.parseQuery().get('e'));
      });
    }).catch(function (e) {
      showState('bad', '⚠', '啟動失敗', Hub.esc(e && e.message ? e.message : '不明原因') +
        '<br>多半是 LIFF ID 填錯，或後台的 Endpoint 網址跟這一頁的網址對不起來。');
    });
  }

  function attemptCheckin(cfg, idToken, eventId) {
    return Hub.callGas(cfg.gasUrl, { op: 'checkin', idToken: idToken, e: eventId }).then(function (res) {
      if (res.ok && res.duplicate) {
        showState('warn', '↻', '已經報到過了', res.time ? ('時間：' + Hub.esc(res.time)) : '');
        return;
      }
      if (res.ok) {
        showState('ok', '✓', '報到成功', Hub.esc(cfg.chapterName || '') + '｜歡迎回來');
        return;
      }
      if (res.error === 'not_bound') {
        showForm(eventId, function (name, industry, onErr) {
          Hub.callGas(cfg.gasUrl, { op: 'bind', idToken: idToken, name: name, industry: industry })
            .then(function (bres) {
              if (!bres.ok) { onErr(bres.error || '綁定失敗'); return; }
              return attemptCheckin(cfg, idToken, eventId);
            })
            .catch(function (e) { onErr(e && e.message ? e.message : '網路錯誤，請再試一次'); });
        });
        return;
      }
      if (res.error === 'event_closed') {
        showState('warn', '⏱', '已截止', '報到時間已經結束，請找幹部台補登。');
        return;
      }
      if (res.error && /查無/.test(res.error)) {
        showState('bad', '✕', '查無此活動', '請確認 QR 碼是否為今天例會，或跟窗口確認。');
        return;
      }
      showState('bad', '✕', '報到失敗', Hub.esc(res.error || '不明原因'));
    }).catch(function (e) {
      showState('bad', '⚠', '連線失敗', Hub.esc(e && e.message ? e.message : '不明原因') + '，請檢查網路後重新整理。');
    });
  }

  document.addEventListener('DOMContentLoaded', run);
})();
