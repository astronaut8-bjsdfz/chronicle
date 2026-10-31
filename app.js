/* ============================================================
   app.js —— 班级编年史
   ------------------------------------------------------------
   两种数据来源，走同一套渲染：
     1) 数据库通了 → 读 chronicle 表，管理员可以增删改
     2) 表还没建 / 连不上 → 退回内置样例，页面上明说「这是样例」
   一条记录拆成两段：title（短标题，只进格子）＋ body（正文，只进弹层）。
   ============================================================ */
(function () {
  'use strict';

  /* ================= 0. 数据库 ================= */

  var SB = window.CHRONICLE_BACKEND || {};
  var HAS_BACKEND = !!(SB.url && SB.anonKey);
  var TABLE = SB.table || 'chronicle';

  function sbUrl(p) { return SB.url.replace(/\/+$/, '') + '/rest/v1/' + p; }

  function sbFetch(path, opts) {
    var o = opts || {};
    var headers = {
      'apikey': SB.anonKey,
      'Authorization': 'Bearer ' + SB.anonKey,
      'Content-Type': 'application/json'
    };
    if (o.headers) for (var k in o.headers) headers[k] = o.headers[k];

    /* 超时兜底：学校的网、外面的网都可能卡住，而 fetch 默认可以一直挂着。
       挂着的后果是页面永远停在「正在读取」—— 比报错还难受。
       6.5 秒没动静就当连不上，退回样例，页面上说明白。 */
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, o.timeout || 6500) : null;

    return fetch(sbUrl(path), {
      method: o.method || 'GET',
      headers: headers,
      body: o.body,
      signal: ctl ? ctl.signal : undefined
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.text().then(function (t) {
        if (!res.ok) {
          var err = new Error('HTTP ' + res.status);
          err.status = res.status;
          err.text = t;
          try { err.json = JSON.parse(t); } catch (e) { }
          throw err;
        }
        return t ? JSON.parse(t) : null;
      });
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw e;
    });
  }

  /* 把数据库的报错翻成人话。这几个 code 是实测过的：
     42501 是函数里 raise 的口令不对；PGRST202 是函数/参数名对不上；
     PGRST205 是表压根没建。 */
  function sbMsg(e) {
    if (!e) return '出错了';
    if (e.name === 'AbortError') return '等太久了：网太慢，或者这儿连不上';
    if (e.name === 'TypeError') return '连不上网络';
    var j = e.json || {};
    var m = j.message || '';
    if (j.code === '42501' || /口令不正确/.test(m)) return '钥匙不对';
    if (j.code === '22023') return m || '填的内容不合要求';
    if (j.code === 'P0002') return '这条记录已经不在了';
    if (j.code === 'PGRST202' || /Could not find the function/.test(m)) {
      return '数据库函数还没建，先把 supabase-setup-chronicle.sql 跑一遍';
    }
    if (j.code === 'PGRST205' || j.code === '42P01' || e.status === 404) return '编年史表还没建';
    if (m) return m;
    return '出错了（' + (e.status || '?') + '）';
  }

  function isMissingTable(e) {
    var j = (e && e.json) || {};
    return j.code === 'PGRST205' || j.code === '42P01' ||
      (e && e.status === 404 && !/function/i.test(j.message || ''));
  }

  /* ================= 1. 常量 ================= */

  var MON = ['一', '二', '三', '四', '五', '六', '日'];
  var MON_CN = ['一月', '二月', '三月', '四月', '五月', '六月',
    '七月', '八月', '九月', '十月', '十一月', '十二月'];
  /* 分类 → 英文短类名，免得 CSS 里出现中文类名 */
  var CAT = { '班级': 'k1', '活动': 'k2', '学习': 'k3' };
  /* 一格最多摊三条：三条刚好填满一列，第四条起会把行高顶过 .grid 的上限、
     然后被 overflow:hidden 从底下无声裁掉。多出来的走「+N 条」。 */
  var MAXEV = 3;

  /* 每周一色：手挑的 12 个色相，两两相邻差 ≥ 105（色相环短弧）。
     ⚠️ 不按黄金角算 —— 会转出黄绿（60–100）那一段，在深底上发脏、像荧光笔。
     ⚠️ 也不要相近色顺排：换周时新星球长得跟旧的一模一样，等于白做。 */
  var HUE = [196, 322, 150, 268, 30, 186, 310, 55, 230, 340, 110, 255];

  /* 学期第一天：周历从这里开始排，中间没有记录的空周也留着 */
  var TERM_START = parseDay(SB.termStart || '2026-09-01');

  /* ================= 2. 日期工具（全部本地时区，别用 Date 解析字符串） ================= */

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseDay(s) { var a = String(s).split('-'); return new Date(+a[0], +a[1] - 1, +a[2]); }
  function md(d) { return pad(d.getMonth() + 1) + '.' + pad(d.getDate()); }
  function addDays(d, n) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + n); return x;
  }
  /* 周一为一周第一天：周日 getDay()=0 → 退 6 天 */
  function monday(d) { return addDays(d, -((d.getDay() + 6) % 7)); }
  /* 季节：按周所在月份粗分，够用了 */
  function season(d) {
    var m = d.getMonth() + 1;
    if (m >= 3 && m <= 5) return 'SPRING';
    if (m >= 6 && m <= 8) return 'SUMMER';
    if (m >= 9 && m <= 11) return 'AUTUMN';
    return 'WINTER';
  }

  var REAL = new Date();
  var TODAY = new Date(REAL.getFullYear(), REAL.getMonth(), REAL.getDate());
  var TODAYKEY = ymd(TODAY);

  /* ================= 3. 状态 ================= */

  var EV = [];            // 全部记录（按日期升序）
  var WEEKS = [];         // 按周分组，含空周
  var byDay = {};         // 逐日索引
  var CUR = 0, N = 0;
  var CALM = [], MI = 0;
  var busy = false, firstPaint = true;
  var DATA_MODE = 'loading';   // db | demo | empty
  var DATA_ERR = '';

  /* 编辑状态。放在这里而不是「编辑那一节」，是因为 openEv / syncLock 都要看它，
     而那些函数在文件里出现得更早。 */
  var ED = { on: false, label: '', key: '', i: -1 };   /* i = -1 表示新建 */

  var $ = function (id) { return document.getElementById(id); };

  /* ================= 4. 建索引 ================= */

  function buildIndex(list, keepKey) {
    EV = list.slice().sort(function (a, b) {
      return a.d < b.d ? -1 : a.d > b.d ? 1 : (a.id - b.id);
    }).map(function (e, i) { e._i = i; return e; });

    byDay = {};
    EV.forEach(function (e) { (byDay[e.d] = byDay[e.d] || []).push(e); });

    var first = EV.length ? parseDay(EV[0].d) : TODAY;
    var last = EV.length ? parseDay(EV[EV.length - 1].d) : TODAY;
    var s = monday(first < TERM_START ? first : TERM_START);
    var e = monday(last > TODAY ? last : TODAY);

    WEEKS = [];
    for (var t = s; t <= e; t = addDays(t, 7)) {
      var key = ymd(t), days = [];
      for (var k = 0; k < 7; k++) {
        var day = addDays(t, k), ds = ymd(day);
        days.push({
          key: ds, d: day, md: md(day), dow: MON[k],
          ev: (byDay[ds] || [])
        });
      }
      /* ⚠️ 这里不能用 byDay[key] —— byDay 是按「具体某一天」索引的，
         拿周一的 key 去查，只会查到周一当天那一条，整周其他天的记录全丢了。
         原型用的是另一个按周聚合的表；这里直接把这七天拼起来，少一张表少一处错。 */
      var wkEv = [];
      days.forEach(function (d) { wkEv = wkEv.concat(d.ev); });
      WEEKS.push({ start: t, key: key, days: days, ev: wkEv });
    }
    WEEKS.forEach(function (w, i) { w.no = i + 1; });
    N = WEEKS.length;

    /* 定位：优先回到指定的那一周（比如刚保存的那条所在周），否则回本周 */
    var want = keepKey || ymd(monday(TODAY));
    var i = WEEKS.findIndex(function (w) { return w.key === want; });
    CUR = i >= 0 ? i : Math.max(0, WEEKS.findIndex(function (w) { return w.key === ymd(monday(TODAY)); }));
    if (CUR < 0) CUR = 0;

    /* 日历月份范围跟着数据走 */
    CALM = [];
    var q0 = WEEKS.length ? WEEKS[0].start : TODAY;
    var q1 = WEEKS.length ? WEEKS[N - 1].start : TODAY;
    for (var q = q0.getFullYear() * 12 + q0.getMonth();
      q <= q1.getFullYear() * 12 + q1.getMonth(); q++) {
      CALM.push({ y: Math.floor(q / 12), m: q % 12 });
    }
    var wantM = MI < CALM.length && CALM[MI] ? CALM[MI] : null;
    if (!wantM) {
      var mi = CALM.findIndex(function (c) {
        return c.y === WEEKS[CUR].start.getFullYear() && c.m === WEEKS[CUR].start.getMonth();
      });
      MI = mi >= 0 ? mi : 0;
    }
    if (MI < 0) MI = 0;
    if (MI > CALM.length - 1) MI = CALM.length - 1;
  }

  /* ================= 5. 背景星屑（只做一次） ================= */
  (function () {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < 90; i++) {
      var s = document.createElement('i');
      var r = Math.random() * 1.5 + .5;
      s.style.cssText = 'width:' + r.toFixed(1) + 'px;height:' + r.toFixed(1) + 'px;'
        + 'left:' + (Math.random() * 100).toFixed(2) + '%;top:' + (Math.random() * 100).toFixed(2) + '%;'
        + 'opacity:' + (.1 + Math.random() * .42).toFixed(2);
      frag.appendChild(s);
    }
    $('dust').appendChild(frag);
  })();

  /* ================= 6. 渲染变量 ================= */

  var planet = $('planet'), grid = $('grid'), stops = $('stops');
  var stopEls = [], rail = document.querySelector('.rail');
  var sheet = $('sheet'), sBd = $('sBd');
  var cellsEl = $('cells'), listEl = $('callist');

  /* 航线：数据一变站数就变，只能重建；平时翻周只改 class，不碰 DOM */
  function buildStops() {
    stops.innerHTML = '';
    stopEls = [];
    WEEKS.forEach(function (w, i) {
      var b = document.createElement('button');
      b.className = 'st';
      b.innerHTML = '<span class="dot"></span><span class="lab"><b>W' + pad(w.no)
        + '</b><span>' + md(w.start) + '</span></span>';
      b.addEventListener('click', function () { jump(i); });
      stops.appendChild(b);
      stopEls.push(b);
    });
    stops.style.gridTemplateColumns = 'repeat(' + N + ',1fr)';
    var inset = (100 / (2 * N)) + '%';
    rail.style.left = inset; rail.style.right = inset;
  }

  /* ================= 7. 文案 ================= */

  /* 这一周叫什么 —— 不再靠手写，按日期算出来，永远不错位 */
  function weekPhrase(w) {
    if (w.key === ymd(monday(TERM_START))) return '开学第一周';
    var s = w.start, e = addDays(s, 6);
    var m = s.getMonth();
    var endOfMonth = new Date(s.getFullYear(), m + 1, 0).getDate();
    var name = MON_CN[m];

    if (e.getMonth() !== m) {
      /* 跨月：看哪个月占的天数多 */
      if (s.getDate() <= 3) return MON_CN[e.getMonth()] + '的第一周';
      return name + '的最后一周';
    }
    if (s.getDate() <= 7) return name + '的第一周';
    if (e.getDate() >= endOfMonth) return name + '的最后一周';
    return name + '的第 ' + (Math.ceil(s.getDate() / 7)) + ' 周';
  }

  /* ================= 8. 周视图 ================= */

  function paint() {
    var w = WEEKS[CUR];
    if (!w) return;

    var isThisWeek = w.key === ymd(monday(TODAY));
    var isFuture = w.key > ymd(monday(TODAY));

    /* 星球：每周一色，星球 / 光环 / 环境辉光 / 顶栏那个点 全取同一个 --h */
    var h = HUE[CUR % HUE.length];
    document.documentElement.style.setProperty('--h', h);
    /* 跃迁过去时让新星球「浮现」一下；首次进站不播，否则一打开就在闪 */
    if (!firstPaint) replay(planet, 'swap', 1100);

    /* 读数 */
    var n = w.ev.length;
    var dayN = w.days.filter(function (d) { return d.ev.length; }).length;
    $('wkno').textContent = 'WEEK ' + pad(w.no) + ' / ' + pad(N);
    $('range').textContent = md(w.start) + ' — ' + md(addDays(w.start, 6));
    $('cnt').textContent = n ? n + ' 条记录' : '没有记录';
    $('kicker').textContent = 'WEEK ' + pad(w.no) + ' · ' + w.start.getFullYear() + ' ' + season(w.start)
      + (isFuture ? ' · 还没到' : (isThisWeek ? ' · 本周' : ''));
    $('note').textContent = weekPhrase(w);

    var dowList = w.days.filter(function (d) { return d.ev.length; })
      .map(function (d) { return '周' + d.dow; });
    $('lede').textContent = n
      ? '记录落在' + dowList.join('、') + '。'
      + (7 - dayN >= 4 ? '其余几天什么都没发生 —— 这也很正常。' : '')
      : '这一周什么都没有留下。空着也是一种记录。';

    $('m1').textContent = n;
    $('m2').textContent = dayN;

    /* 周历 */
    var html = '';
    w.days.forEach(function (d, k) {
      var isToday = d.key === TODAYKEY;
      var cls = 'col' + (k >= 5 ? ' we' : '') + (isToday ? ' today' : '');
      html += '<div class="' + cls + '"><div class="hd"><span class="dow">周'
        + d.dow + (isToday ? ' · 今天' : '') + '</span><span class="md">'
        + d.md.slice(3) + '</span></div>';
      if (!d.ev.length) {
        html += '<span class="none">—</span>';
      } else {
        html += '<div class="evlist">';
        d.ev.slice(0, MAXEV).forEach(function (e) {
          html += '<div class="ev' + (d.key > TODAYKEY ? ' future' : '') + '" data-i="' + e._i + '">'
            + '<span class="c">' + esc(e.c) + '</span><span class="t">' + esc(e.t) + '</span></div>';
        });
        if (d.ev.length > MAXEV) {
          html += '<button class="evmore" data-day="' + d.key + '">+'
            + (d.ev.length - MAXEV) + ' 条</button>';
        }
        html += '</div>';
      }
      html += '</div>';
    });
    grid.innerHTML = html;

    /* 航线 */
    stopEls.forEach(function (el, i) {
      /* ⚠️ 三个分支都必须带前导空格。写成 'future'（少一个空格）会拼出
         class="stfuture"，整个 .st 规则全部失效 —— 按钮退回浏览器默认样式，
         底部航线未来那一段会变成一排白底方块。只在「当前周之后还有周」时才露头，
         数据没跨到今天时完全看不出来（2026-10-31 导入 8 月起的数据才踩到）。 */
      el.className = 'st' + (i === CUR ? ' cur' : (i < CUR ? ' past' : ' future'));
    });
    var pct = N > 1 ? (CUR / (N - 1)) * 100 : 0;
    $('done').style.width = pct + '%';
    $('head').style.left = pct + '%';

    /* 下一场考试：只在标题里带「考」字的未来记录上算，别把随便一条「学习」
       当成考试倒计时 —— 那会显示成「3 天后物理小测」这种莫名其妙的话 */
    var mid = EV.filter(function (e) {
      return parseDay(e.d) > TODAY && /考/.test(e.t);
    })[0];
    if (mid) {
      var dd = Math.round((parseDay(mid.d) - TODAY) / 86400000);
      $('m3').textContent = dd;
      $('m3wrap').lastElementChild.textContent = '天后' + mid.t.slice(0, 4);
      $('m3wrap').style.display = '';
    } else {
      $('m3wrap').style.display = 'none';
    }

    firstPaint = false;
  }

  /* ================= 9. 过渡 ================= */

  function replay(el, cls, ms) {
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove(cls); }, ms);
  }

  function warp(fast) {
    replay($('warp'), 'go', fast ? 680 : 980);
    /* ⚠️ 必须 toggle：原来是「fast 才 add、从不 remove」，
       只要有一次快跃迁，之后所有跃迁都变快。 */
    $('warp').classList.toggle('fast', !!fast);
  }

  function fly(dir) {
    var r = $('lift');
    r.classList.remove('fly', 'fly-l'); void r.offsetWidth;
    r.classList.add(dir > 0 ? 'fly' : 'fly-l');
    clearTimeout(r._t);
    r._t = setTimeout(function () { r.classList.remove('fly', 'fly-l'); }, 1100);
  }

  function goTo(idx, dir, useRocket) {
    if (busy || idx === CUR || idx < 0 || idx >= N) return;
    busy = true;
    if (useRocket) fly(dir);
    replay($('band'), 'go', 980);
    warp(!useRocket);
    /* 遮罩盖住屏幕的那一刻换内容 —— 换的时候画面是黑的，看不出跳变 */
    setTimeout(function () { CUR = idx; paint(); }, useRocket ? 340 : 250);
    setTimeout(function () { busy = false; }, useRocket ? 1120 : 700);
  }

  function next() { CUR < N - 1 ? goTo(CUR + 1, 1, true) : bump(); }
  function prev() { CUR > 0 ? goTo(CUR - 1, -1, true) : bump(); }
  function jump(i) { if (i !== CUR) goTo(i, i > CUR ? 1 : -1, false); }

  function bump() {
    replay($('lift'), 'shake', 440);
    toast(CUR === N - 1 ? '已经是最后一颗了' : '已经是最早的一颗了', 1800);
  }

  /* 底部短提示。原型里的 toast 只有「到边界了」一种用法，
     加了编辑之后还要报「保存失败」之类，所以抽成函数。 */
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    replay(t, 'on', ms || 2400);
  }

  $('lift').addEventListener('click', next);

  /* ================= 10. 详情弹层 ================= */

  /* 数据是别人填的，一律转义；否则一条带 < 的记录就能拆掉整个版面 */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function weekNoOf(key) {
    for (var i = 0; i < WEEKS.length; i++) {
      for (var j = 0; j < 7; j++) if (WEEKS[i].days[j].key === key) return WEEKS[i].no;
    }
    return 0;
  }
  function syncLock() {
    var any = sheet.classList.contains('on') || editor.classList.contains('on')
      || gate.classList.contains('on');
    document.documentElement.style.overflow = any ? 'hidden' : '';
  }
  function openSheet(el) {
    el.classList.add('on');
    el.setAttribute('aria-hidden', 'false');
    syncLock();
  }
  function closeSheetEl(el) {
    el.classList.remove('on');
    el.setAttribute('aria-hidden', 'true');
    syncLock();
  }

  function openEv(i) {
    var e = EV[i]; if (!e) return;
    var d = parseDay(e.d), wn = pad(weekNoOf(e.d));
    $('sDay').innerHTML = md(d) + ' · 周' + MON[(d.getDay() + 6) % 7]
      + ' <b>W' + wn + '</b>';
    var h = '<span class="tag">' + esc(e.c) + '</span>'
      + '<h2 id="sTitle">' + esc(e.t) + '</h2>'
      + '<p class="txt' + (e.b ? '' : ' empty') + '">'
      + (e.b ? esc(e.b) : '这一条只留了标题，没有更多内容。') + '</p>';
    if (e.img) h += '<img class="ph" src="' + esc(e.img) + '" alt="" loading="lazy">';
    h += '<p class="foot">' + e.d + ' · 第 ' + wn + ' 周</p>';
    if (ED.on) {
      h += '<div class="footacts"><span class="sp"></span>'
        + '<button class="btn" data-act="edit" data-i="' + e._i + '">改这条</button>'
        + '<button class="btn danger" data-act="del" data-i="' + e._i + '">删除</button></div>';
    }
    sBd.innerHTML = h;
    sBd._idx = i;                 /* 登录后要把这条重画成带「改/删」的样子 */
    sBd.scrollTop = 0;
    openSheet(sheet);
    $('sX').focus();
  }

  function closeSheet() { closeSheetEl(sheet); }

  /* 「+N 条」：一天有四五条时，格子只摊三条，剩下的在这里一次看完 */
  function openDay(key) {
    var evs = byDay[key] || [];
    if (!evs.length) return;
    if (evs.length === 1) { openEv(evs[0]._i); return; }
    var d = parseDay(key), wn = pad(weekNoOf(key));
    $('sDay').innerHTML = md(d) + ' · 周' + MON[(d.getDay() + 6) % 7] + ' <b>W' + wn + '</b>';
    var h = '<span class="tag">' + evs.length + ' 条记录</span><div class="dl">';
    evs.forEach(function (e) {
      var sum = e.b ? e.b.replace(/\s+/g, ' ') : '这一条只留了标题。';
      h += '<button class="row" data-i="' + e._i + '">'
        + '<i class="' + (CAT[e.c] || '') + '"></i>'
        + '<span><b>' + esc(e.t) + '</b><em>' + esc(sum) + '</em></span></button>';
    });
    h += '</div><p class="foot">点一条看全文 · ' + key + '</p>';
    sBd.innerHTML = h;
    sBd.scrollTop = 0;
    openSheet(sheet);
    $('sX').focus();
  }

  /* 格子里是 innerHTML 重建的，逐条绑定会随重建失效 —— 一律委托 */
  grid.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    var more = e.target.closest('.evmore[data-day]');
    if (more) { openDay(more.dataset.day); return; }
    var t = e.target.closest('.ev[data-i]');
    if (t) openEv(+t.dataset.i);
  });
  sheet.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    if (e.target.hasAttribute('data-close') || e.target.id === 'sX') { closeSheet(); return; }
    var act = e.target.closest('[data-act]');
    if (act) {
      var i = +act.dataset.i;
      if (act.dataset.act === 'edit') { closeSheet(); openEditor(i); }
      else if (act.dataset.act === 'del') doDelete(i);
      return;
    }
    var row = e.target.closest('.row[data-i]');
    if (row) openEv(+row.dataset.i);
  });

  /* ================= 11. 日历版 ================= */

  (function () {
    var h = '';
    for (var i = 0; i < 7; i++) h += '<span' + (i >= 5 ? ' class="we"' : '') + '>周' + MON[i] + '</span>';
    $('dows').innerHTML = h;
  })();

  function paintCal() {
    if (!CALM.length) return;
    var c = CALM[MI], y = c.y, m = c.m;
    var first = new Date(y, m, 1);
    var lead = (first.getDay() + 6) % 7;        /* 周一开头 */
    var start = addDays(first, -lead);
    var html = '', nRec = 0, nDay = 0;

    /* 行数按本月实际需要算（5 或 6 行）：固定 42 格会让月底多出一整行灰的 */
    var nDaysM = new Date(y, m + 1, 0).getDate();
    var rows = Math.ceil((lead + nDaysM) / 7);
    cellsEl.style.gridTemplateRows = 'repeat(' + rows + ',minmax(0,1fr))';
    /* 92px/行 是「日号 + 两条标题」刚好的高度；矮屏上让位给视口 */
    cellsEl.style.height = 'min(' + (rows * 92) + 'px, calc(100vh - 240px))';

    for (var i = 0; i < rows * 7; i++) {
      var d = addDays(start, i), key = ymd(d);
      var inM = d.getMonth() === m && d.getFullYear() === y;
      var evs = byDay[key] || [];
      if (inM && evs.length) { nRec += evs.length; nDay++; }

      var cls = 'cell' + (inM ? '' : ' out')
        + ((d.getDay() === 0 || d.getDay() === 6) ? ' we' : '')
        + (evs.length ? ' has' : '')
        + (key === TODAYKEY ? ' today' : '');

      html += '<div class="' + cls + '"' + (evs.length ? ' data-d="' + key + '"' : '') + '>'
        + '<div class="ch"><span class="dn">' + d.getDate() + '</span>';
      if (evs.length) {
        html += '<span class="dots">' + evs.slice(0, 3).map(function (e) {
          return '<i class="' + (CAT[e.c] || '') + '"></i>';
        }).join('') + '</span>';
      }
      html += '</div>';

      if (inM && evs.length) {
        html += '<div class="cl">';
        evs.slice(0, 2).forEach(function (e) {
          html += '<div class="ci ' + (CAT[e.c] || '') + (e.d > TODAYKEY ? ' future' : '') + '">'
            + '<span>' + esc(e.t) + '</span></div>';
        });
        if (evs.length > 2) html += '<div class="cm">+' + (evs.length - 2) + ' 条</div>';
        html += '</div>';
      }
      html += '</div>';
    }
    cellsEl.innerHTML = html;

    /* 头 */
    $('calY').textContent = y;
    $('calM').textContent = MON_CN[m];
    $('calStat').textContent = nRec ? (nRec + ' 条记录 · ' + nDay + ' 天') : '这个月没有记录';
    $('moPrev').disabled = MI === 0;
    $('moNext').disabled = MI === CALM.length - 1;

    /* 日历是全局视角，顶栏就别再挂「当前第几周」了 */
    var nDayAll = Object.keys(byDay).length;
    $('calline').textContent = (WEEKS.length ? WEEKS[0].start.getFullYear() : y) + ' '
      + season(new Date(y, m, 1)) + ' · ' + EV.length + ' 条'
      + (nDayAll && nDayAll !== EV.length ? ' · ' + nDayAll + ' 天' : '');

    /* 手机：格子里只放得下日号，标题在这个列表里补回来 */
    var items = EV.filter(function (e) {
      var ed = parseDay(e.d);
      return ed.getFullYear() === y && ed.getMonth() === m;
    });
    listEl.innerHTML = items.length
      ? items.map(function (e) {
        return '<button class="li" data-d="' + e.d + '">'
          + '<span class="ld">' + md(parseDay(e.d)) + '</span>'
          + '<span class="lt"><i class="' + (CAT[e.c] || '') + '"></i>' + esc(e.t) + '</span></button>';
      }).join('')
      : '<div class="li" style="cursor:default"><span class="ld">—</span>'
      + '<span class="lt">这个月什么都没有留下。</span></div>';
  }

  function moGo(delta) {
    var i = MI + delta;
    if (i < 0 || i >= CALM.length) return;
    MI = i;
    paintCal();
    replay(cellsEl, delta > 0 ? 'turnr' : 'turnl', 440);
  }

  /* ================= 12. 视图切换 ================= */

  var vtEl = $('vt'), VIEW = 'week';
  var vbtns = [].slice.call(vtEl.querySelectorAll('.vbtn'));

  function setView(v, force) {
    if (v === VIEW && !force) return;   /* force 只为初始化时把按钮态摆正 */
    VIEW = v;
    document.body.dataset.view = v;
    vtEl.dataset.at = (v === 'cal' ? '0' : '1');
    vbtns.forEach(function (b) {
      var on = b.dataset.v === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    window.scrollTo(0, 0);
    if (v === 'cal') {
      /* 从「第几周」切过来，用户想看的是那一周所在的月份；但翻过月就不打扰了 */
      var ws = WEEKS[CUR] ? WEEKS[CUR].start : TODAY;
      var ci = CALM.findIndex(function (c) {
        return c.y === ws.getFullYear() && c.m === ws.getMonth();
      });
      if (ci >= 0) MI = ci;
      paintCal();
    }
  }

  vbtns.forEach(function (b) {
    b.addEventListener('click', function () { setView(b.dataset.v); });
  });

  /* 日历上点某一天 → 回到时间线，落在它那一周 */
  function openWeekOf(key) {
    var i = -1;
    for (var q2 = 0; q2 < WEEKS.length; q2++) {
      if (WEEKS[q2].days.some(function (d) { return d.key === key; })) { i = q2; break; }
    }
    if (i < 0) return;
    warp(true);
    replay($('band'), 'go', 980);
    setTimeout(function () {
      if (i !== CUR) { CUR = i; paint(); }
      setView('week');
    }, 230);
  }

  cellsEl.addEventListener('click', function (e) {
    var cell = e.target.closest ? e.target.closest('.cell[data-d]') : null;
    if (cell) openWeekOf(cell.dataset.d);
  });
  listEl.addEventListener('click', function (e) {
    var li = e.target.closest ? e.target.closest('.li[data-d]') : null;
    if (li) openWeekOf(li.dataset.d);
  });
  $('moPrev').addEventListener('click', function () { moGo(-1); });
  $('moNext').addEventListener('click', function () { moGo(1); });
  $('moToday').addEventListener('click', function () {
    var i = CALM.findIndex(function (c) {
      return c.y === TODAY.getFullYear() && c.m === TODAY.getMonth();
    });
    if (i >= 0 && i !== MI) {
      var dlt = i > MI ? 1 : -1; MI = i; paintCal();
      replay(cellsEl, dlt > 0 ? 'turnr' : 'turnl', 440);
    }
  });

  addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (editor.classList.contains('on')) { closeEditor(); return; }
      if (gate.classList.contains('on')) { closeSheetEl(gate); return; }
    }
    /* 弹层开着的时候方向键不该偷偷翻周 */
    if (sheet.classList.contains('on')) {
      if (e.key === 'Escape') closeSheet();
      return;
    }
    if (editor.classList.contains('on') || gate.classList.contains('on')) return;
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    var fwd = e.key === 'ArrowRight';
    if (VIEW === 'cal') { fwd ? moGo(1) : moGo(-1); }   /* 日历里方向键翻月 */
    else { fwd ? next() : prev(); }
  });

  /* ================= 13. 编辑 · 钥匙 ================= */

  var editor = $('editor'), gate = $('gate');
  var LS_KEY = 'chron.key.v1';
  var LS_LABEL = 'chron.label.v1';

  function readLS(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function writeLS(k, v) {
    try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { }
  }

  function showEdbar(on) {
    $('edbar').hidden = !on;
    document.body.classList.toggle('editing', on);
  }

  function enterEdit(label) {
    ED.on = true;
    ED.label = label || '';
    showEdbar(true);
    $('edWho').textContent = '编辑中' + (label ? ' · ' + label : '');
    $('edTip').textContent = '点任意一条可以改也可以删';
    /* 详情弹层已经开着时，底部那条「改 / 删」要立刻补上 —— 重画一次就有了 */
    if (sheet.classList.contains('on') && sBd._idx != null && EV[sBd._idx]) {
      openEv(sBd._idx);
    }
  }

  function leaveEdit() {
    ED.on = false; ED.key = ''; ED.label = '';
    writeLS(LS_KEY, ''); writeLS(LS_LABEL, '');
    showEdbar(false);
    closeEditor();
    closeSheet();
    toast('已经退出编辑');
  }

  /* 顶栏最右那个 4px 的点：连点三下才出钥匙框。放个显眼按钮等于告诉
     全班「这里有后台」，而这个站点是给同学看的。 */
  var gateHits = 0, gateTimer = null;
  $('gate3').addEventListener('click', function () {
    gateHits++;
    clearTimeout(gateTimer);
    gateTimer = setTimeout(function () { gateHits = 0; }, 900);
    if (gateHits >= 3) { gateHits = 0; openGate(); }
  });

  function openGate() {
    if (ED.on) { openEditor(-1); return; }
    $('fKey').value = '';
    openSheet(gate);
    setTimeout(function () { $('fKey').focus(); }, 60);
  }

  $('gCancel').addEventListener('click', function () { closeSheetEl(gate); });
  $('gX').addEventListener('click', function () { closeSheetEl(gate); });
  gate.addEventListener('click', function (e) {
    if (e.target.hasAttribute && e.target.hasAttribute('data-close')) closeSheetEl(gate);
  });

  $('gForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var key = $('fKey').value.trim();
    if (!key) return;
    var btn = $('gGo');
    btn.disabled = true;
    btn.textContent = '验证中…';
    sbFetch('rpc/chron_ok', { method: 'POST', body: JSON.stringify({ p_key: key }) })
      .then(function (label) {
        if (!label && label !== '') throw new Error('__empty__');
        /* chron_ok 成功时返回 label，可能是空串（发了钥匙但没写名字） */
        if (typeof label === 'string') {
          ED.key = key;
          writeLS(LS_KEY, key);
          writeLS(LS_LABEL, label);
          closeSheetEl(gate);
          enterEdit(label);
          toast('进来了，点任意一条就能改');
          return;
        }
        throw new Error('__empty__');
      })
      .catch(function (err) {
        if (err && err.message === '__empty__') { toast('钥匙不对'); return; }
        toast(sbMsg(err));
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = '进去';
      });
  });

  /* 打开页面时如果这把设备记着钥匙，静默验一次。
     ⚠️ 只有明确返回空串才清掉钥匙；网络不通时保留 —— 否则在教室里
        断一次网，管理员就得重新翻聊天记录找钥匙。 */
  function autoLogin() {
    var k = readLS(LS_KEY);
    if (!k || !HAS_BACKEND) return;
    sbFetch('rpc/chron_ok', { method: 'POST', body: JSON.stringify({ p_key: k }) })
      .then(function (label) {
        if (typeof label === 'string') {
          ED.key = k;
          enterEdit(label || readLS(LS_LABEL));
        } else {
          writeLS(LS_KEY, '');
        }
      })
      .catch(function () { /* 网络问题，先留着 */ });
  }

  /* ================= 14. 编辑 · 表单 ================= */

  var edForm = $('edForm'), fDay = $('fDay'), fTitle = $('fTitle'),
    fBody = $('fBody'), fImg = $('fImg'), fCat = $('fCat');

  function setCat(c) {
    [].forEach.call(fCat.querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b.dataset.c === c);
    });
  }
  function getCat() {
    var on = fCat.querySelector('button.on');
    return on ? on.dataset.c : '班级';
  }
  fCat.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-c]') : null;
    if (b) setCat(b.dataset.c);
  });

  function countBox() {
    var t = $('fTn'), b = $('fBn');
    t.textContent = fTitle.value.length + ' / 40';
    t.classList.toggle('full', fTitle.value.length >= 40);
    b.textContent = fBody.value.length + ' / 4000';
    b.classList.toggle('full', fBody.value.length >= 4000);
  }
  fTitle.addEventListener('input', countBox);
  fBody.addEventListener('input', countBox);

  /* i = -1 新建；否则改第 i 条 */
  function openEditor(i) {
    ED.i = (typeof i === 'number') ? i : -1;
    var e = ED.i >= 0 ? EV[ED.i] : null;

    $('edTitle').textContent = e ? '改一条' : '记一条';
    $('fDel').hidden = !e;
    fDay.value = e ? e.d : defaultDay();
    setCat(e ? e.c : '班级');
    fTitle.value = e ? e.t : '';
    fBody.value = e ? (e.b || '') : '';
    fImg.value = e ? (e.img || '') : '';
    countBox();

    openSheet(editor);
    setTimeout(function () {
      if (e) fTitle.focus(); else fDay.focus();
    }, 80);
  }

  /* 新建时的默认日期：先看今天在不在当前这一周，在就填今天；不在就填那周的周一 */
  function defaultDay() {
    var w = WEEKS[CUR];
    if (!w) return TODAYKEY;
    var inWeek = w.days.some(function (d) { return d.key === TODAYKEY; });
    return inWeek ? TODAYKEY : ymd(w.start);
  }

  function closeEditor() { closeSheetEl(editor); }
  $('fCancel').addEventListener('click', closeEditor);
  $('edX').addEventListener('click', closeEditor);
  editor.addEventListener('click', function (e) {
    if (e.target.hasAttribute && e.target.hasAttribute('data-close')) closeEditor();
  });

  function setSaving(on, txt) {
    var b = $('fSave');
    b.disabled = on;
    b.innerHTML = on ? '<span class="spin"></span>' + (txt || '保存中') : '保存';
  }

  edForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!ED.on) { toast('先输钥匙'); return; }
    var day = fDay.value;
    var title = fTitle.value.trim();
    if (!day) { toast('选个日期'); fDay.focus(); return; }
    if (!title) { toast('标题不能空着'); fTitle.focus(); return; }

    var body = {
      p_key: ED.key,
      p_id: ED.i >= 0 ? (EV[ED.i].id || 0) : 0,
      p_day: day,
      p_title: title,
      p_body: fBody.value,
      p_cat: getCat(),
      p_img: fImg.value.trim()
    };
    setSaving(true);
    sbFetch('rpc/chron_save', { method: 'POST', body: JSON.stringify(body) })
      .then(function () {
        closeEditor();
        toast(ED.i >= 0 ? '改好了' : '记下了');
        return refresh(ymd(monday(parseDay(day))));
      })
      .catch(function (err) {
        toast(sbMsg(err));
        if (/钥匙/.test(sbMsg(err))) leaveEdit();
      })
      .then(function () { setSaving(false); });
  });

  $('fDel').addEventListener('click', function () {
    if (ED.i >= 0) doDelete(ED.i, true);
  });

  /* ================= 15. 删 / 刷新 ================= */

  function doDelete(i, fromEditor) {
    var e = EV[i];
    if (!e || !ED.on) return;
    var msg = '删掉「' + e.t + '」？删了就找不回来了。';
    if (!confirm(msg)) return;
    sbFetch('rpc/chron_del', {
      method: 'POST',
      body: JSON.stringify({ p_key: ED.key, p_id: e.id })
    }).then(function () {
      if (fromEditor) closeEditor();
      closeSheet();
      toast('删掉了');
      return refresh();
    }).catch(function (err) {
      toast(sbMsg(err));
    });
  }

  /* 重新拉一遍数据；keepKey 是要落在的那一周 */
  function refresh(keepKey) {
    if (!HAS_BACKEND) return Promise.resolve();
    return loadRows().then(function (rows) {
      var wasEmpty = DATA_MODE === 'empty';
      DATA_MODE = rows.length ? 'db' : 'empty';
      DATA_ERR = '';
      if (wasEmpty && rows.length) setNotice('', '');   /* 第一条记下了，空站提示该撤 */
      var list = rows.map(mapRow);
      buildIndex(list, keepKey);
      buildStops();
      paint();
      paintCal();
    }).catch(function (err) {
      toast(sbMsg(err));
    });
  }

  $('edOut').addEventListener('click', leaveEdit);
  $('edNew').addEventListener('click', function () { openEditor(-1); });

  /* ================= 16. 数据加载 ================= */

  function mapRow(r) {
    return {
      id: Number(r.id),
      d: String(r.day || '').slice(0, 10),
      t: r.title || '',
      b: r.body || '',
      c: (r.cat === '活动' || r.cat === '学习') ? r.cat : '班级',
      img: r.img || ''
    };
  }

  function loadRows() {
    return sbFetch(TABLE + '?select=id,day,title,body,cat,img'
      + '&order=day.asc,id.asc&limit=2000');
  }

  /* 内置样例：只在数据库还没建好时出现，页面上会明说是样例。
     日期故意压在 2026 秋季，跟真实学期同段，方便看版式效果。 */
  var DEMO = [
    { id: 1, d: '2026-09-01', c: '班级', t: '开学第一天', b: '四十一个人，名单上四十一行。上午排座位，下午领书，谁跟谁坐同桌，就这么定下来一个学期。\n班主任站在讲台上说的第一句是：「三年很快就过去了。」当时没人信。' },
    { id: 2, d: '2026-09-02', c: '班级', t: '第一期黑板报', b: '主题是「新起点」。画了三个晚上，最后被粉笔灰糊掉的比画上去的多。\n班名用最大号的字写在正中间。' },
    { id: 3, d: '2026-09-07', c: '活动', t: '军训第一天', b: '晒到胳膊发红。教官说站军姿要把下巴收回去，结果一收，眼睛就不知道往哪看了。' },
    { id: 4, d: '2026-09-11', c: '活动', t: '会操', b: '站到最后一排都在抖。走完最后一遍、队伍散开的那一秒，全场都在甩胳膊。' },
    { id: 5, d: '2026-09-16', c: '班级', t: '第一次自我介绍', b: '每人一分钟，有人讲了整整五分钟。\n那天记下来的名字，后来有一半还是叫不全。' },
    { id: 6, d: '2026-09-18', c: '班级', t: '班徽定稿', b: '一个圈，中间是个 8。投票那天收了七份稿子，最后选中的是最简单的那份。' },
    { id: 7, d: '2026-09-24', c: '活动', t: '篮球赛第一场', b: '输了 6 分。最后两分钟追回来 4 分，然后被一个三分球按死。\n场边喊得最响的那个人，第二天嗓子哑了。' },
    { id: 8, d: '2026-09-30', c: '班级', t: '国庆前最后一下午', b: '没人想上课。最后一节自习，黑板上写满了「假期愉快」，被值日生擦了一半又停下。' },
    { id: 9, d: '2026-10-12', c: '活动', t: '运动会 · 4×100 第三', b: '四个人，四棒。第三棒交接的时候差点掉棒，手在空气里抓了两下，抓到了。\n跑完在看台下坐了很久，谁都没说话，然后一起笑出来。\n这是这个秋天最好的一天。' },
    { id: 10, d: '2026-10-16', c: '活动', t: '合唱节', b: '唱跑了一个声部。第二段副歌，第二排从左边数第四个人提前半拍进来，然后整排跟着他跑了。\n下台之后指挥说「挺好」，没人知道他是真觉得好，还是不想说。' },
    { id: 11, d: '2026-10-20', c: '学习', t: '第一次月考', b: '成绩表在走廊贴了一节课。看的人比贴的人多，走了又回来的也不少。' },
    { id: 12, d: '2026-10-23', c: '班级', t: '值日表重排', b: '班会上重新排下个月的值日。有人换到周三，有人换到周五。' },
    { id: 13, d: '2026-10-27', c: '活动', t: '体检', b: '排队排了四十分钟。量身高的时候所有人都把脚跟贴紧、把脖子往上伸，测完再偷偷比一遍数字。' },
    { id: 14, d: '2026-10-29', c: '班级', t: '图书角开张', b: '一个旧书架，从办公室后面搬来的，擦了三遍还有灰。\n第一本被借走的是《三体》，借书的人说小学看过一遍，想再看一遍。\n登记表是用 A4 纸手画的：书名、借的人、借的日期、还的日期。第一天填了六行。\n\n书架第二层最右边那格还空着。' }
  ];

  function setNotice(kind, html) {
    var n = $('notice');
    if (!html) { n.hidden = true; return; }
    n.className = 'notice' + (kind === 'warn' ? ' warn' : '');
    n.innerHTML = html;
    n.hidden = false;
  }

  function finish() {
    buildStops();
    setView('week', true);
    paint();
    paintCal();
    autoLogin();
    window.__ready = true;
  }

  function boot() {
    if (!HAS_BACKEND) {
      DATA_MODE = 'demo';
      buildIndex(DEMO, null);
      setNotice('warn', '<b>没配置数据库</b>现在显示的是内置样例，改了也不会保存。');
      finish();
      return;
    }
    loadRows().then(function (rows) {
      DATA_MODE = rows.length ? 'db' : 'empty';
      buildIndex(rows.map(mapRow), null);
      if (!rows.length) {
        setNotice('', '<b>还没有记录</b>这个学期一条都还没记下。'
          + '管理员从右上角进编辑，记完第一条，这块就活了。');
      }
    }).catch(function (err) {
      DATA_MODE = 'demo';
      DATA_ERR = sbMsg(err);
      buildIndex(DEMO, null);
      if (isMissingTable(err)) {
        setNotice('', '<b>样例</b>编年史表还没建，现在显示的是内置样例。'
          + '跑一遍 supabase-setup-chronicle.sql 就会自动换成真数据。');
      } else {
        setNotice('warn', '<b>连不上</b>' + esc(DATA_ERR) + '　现在显示的是内置样例。');
      }
    }).then(finish);
  }

  /* ================= 17. 启动 ================= */

  setView('week', true);
  boot();

  /* 测试与调试用的钩子 */
  window.__week = function (i) { goTo(i, i > CUR ? 1 : -1, true); };
  window.__view = function (v) { setView(v); };
  window.__month = function (i) { MI = i; paintCal(); };
  window.__ev = function (i) { openEv(i); };
  window.__shut = closeSheet;
  window.__new = function () { openEditor(-1); };
  window.__edit = function (i) { openEditor(i); };
  /* 只摆出「编辑中」的样子给验证用；钥匙没填，写操作照样过不去 */
  window.__admin = function (label) { enterEdit(label || '预览'); };
  /* 手工喂一批数据进去看渲染（也用来在没网的时候验证版式） */
  window.__feed = function (list, keepKey) {
    DATA_MODE = 'db';
    buildIndex(list.map(mapRow), keepKey || null);
    buildStops(); paint(); paintCal();
  };
  window.__state = function () {
    return JSON.stringify({
      mode: DATA_MODE, err: DATA_ERR, n: EV.length, weeks: N, cur: CUR,
      view: VIEW, mi: MI, months: CALM.length, editing: ED.on,
      label: ED.label, cell: WEEKS[CUR] ? WEEKS[CUR].key : null,
      note: $('note').textContent, lede: $('lede').textContent
    });
  };
})();
