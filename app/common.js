/* bni-hub 共用邏輯。⚠️ 不准出現任何分會專屬字串——分會中文名／英文代稱／頻道識別碼／後端網址一律從
   window.CHAPTER_SLUG 對應的 chapters/<slug>/config.json 讀，不寫死在這裡。
   驗收：用關鍵字掃描這個資料夾必須零命中。 */
(function (global) {
  'use strict';

  var Hub = {};

  // ---- 設定檔載入：每個分會頁面在自己的 index.html 開頭設定 window.CHAPTER_SLUG ----
  Hub.loadConfig = function () {
    var slug = global.CHAPTER_SLUG;
    if (!slug) return Promise.reject(new Error('CHAPTER_SLUG 未設定'));
    // 這一頁在 /<repo>/<slug>/ 或 /<repo>/<slug>/admin/ 之類的子路徑，
    // 設定檔在 /<repo>/chapters/<slug>/config.json —— 用「往上找到 <slug> 那一層」的方式算相對路徑，
    // 這樣同一支 common.js 不管被哪一層頁面引用，路徑都算得出來。
    var parts = global.location.pathname.split('/').filter(Boolean);
    var idx = parts.lastIndexOf(slug);
    // 要跳出幾層才能回到 <slug>/ 的上一層（repo 根目錄）：
    // <slug> 本身算一層，之後每多一層子資料夾（例如 admin/）再各加一層。
    var upLevels = idx >= 0 ? (parts.length - idx) : 0;
    var up = new Array(upLevels + 1).join('../');
    var url = up + 'chapters/' + slug + '/config.json?_=' + Date.now();
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('config.json 讀取失敗（' + r.status + '）');
      return r.json();
    });
  };

  // ---- liff.state 參數還原：LINE 有時會把網址參數包進 liff.state 轉送 ----
  Hub.parseQuery = function () {
    var q = new URLSearchParams(global.location.search);
    if (q.get('liff.state')) {
      var st = q.get('liff.state');
      var qs = st.indexOf('?') === 0 ? st.slice(1) : st;
      var q2 = new URLSearchParams(qs);
      // liff.state 裡有東西才覆蓋，避免把原本就有的參數洗掉
      var hasAny = false;
      q2.forEach(function () { hasAny = true; });
      if (hasAny) q = q2;
    }
    return q;
  };

  // ---- 呼叫 GAS：一律用純字串 body，瀏覽器會自動下 text/plain，
  //      這樣才不會觸發 CORS 預檢——Apps Script 網頁應用程式不支援 OPTIONS 預檢。
  Hub.callGas = function (gasUrl, payload) {
    return fetch(gasUrl, {
      method: 'POST',
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().catch(function () {
        throw new Error('伺服器回應不是 JSON（HTTP ' + r.status + '）');
      });
    });
  };

  Hub.getGas = function (gasUrl, params) {
    var qs = new URLSearchParams(params || {});
    return fetch(gasUrl + '?' + qs.toString()).then(function (r) {
      return r.json().catch(function () {
        throw new Error('伺服器回應不是 JSON（HTTP ' + r.status + '）');
      });
    });
  };

  Hub.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  Hub.fmtTime = function (iso) {
    try {
      var d = new Date(iso);
      var h = d.getHours(), m = d.getMinutes();
      return (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m);
    } catch (e) { return ''; }
  };

  global.Hub = Hub;
})(window);
