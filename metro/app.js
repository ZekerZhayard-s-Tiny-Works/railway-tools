// 苏州地铁路由查询页面：加载 network.json + 所选星期的时刻表，跑 Router 并渲染方案。
import { Network, Router, planStats, corridorName, formatTime } from './engine.js';
import { renderText } from './render.js';
import { attachSuggest } from '../suggest.js';

const $ = (id) => document.getElementById(id);
const fromInput = $('from'), toInput = $('to');

let raw = null;
const tablesCache = new Map();   // weekday -> { "走廊|站序": [[秒],[秒]] }
const netCache = new Map();      // weekday -> Network

const weekdayOf = (d) => ((d.getDay() + 6) % 7) + 1;

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} 加载失败: HTTP ${r.status}`);
  return r.json();
}

async function networkFor(weekday) {
  if (netCache.has(weekday)) return netCache.get(weekday);
  if (!tablesCache.has(weekday)) {
    $('status').textContent = `正在加载周${'一二三四五六日'[weekday - 1]}时刻表…`;
    tablesCache.set(weekday, (await getJson(`data/tt_w${weekday}.json`)).tables);
  }
  const net = Network.load(raw, tablesCache.get(weekday));
  netCache.set(weekday, net);
  return net;
}

function parseTime(text) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) throw new Error('时间格式应为 HH:MM');
  const h = +m[1], mi = +m[2], s = m[3] ? +m[3] : 0;
  if (h > 23 || mi > 59 || s > 59) throw new Error(`时间超出范围: ${text}`);
  return h * 3600 + mi * 60 + s;
}

function fail(message, suggestions) {
  const st = $('status');
  st.className = 'status err';
  st.textContent = suggestions?.length ? `${message}，相近车站: ${suggestions.slice(0, 8).join('、')}` : message;
  $('result').hidden = true;
}

function renderPlan(net, plans, opts) {
  const summary = $('summary'), timeline = $('timeline');
  if (plans.length === 0) {
    summary.innerHTML = opts.departSec != null
      ? '当日无可达路线<em>（相关车站/方向当日无列车服务，或换乘链断裂）</em>'
      : `当日无法在 <em>${formatTime(opts.arriveSec)}</em> 前到达`;
    timeline.innerHTML = '';
    $('details').hidden = true;
    return;
  }

  const head = plans[0];
  const headText = opts.departSec != null
    ? `最早到达 <em>${formatTime(head.arriveSec)}</em>（${formatTime(head.startSec)} 到站台，候车 ${Math.trunc((head.boardSec - head.startSec) / 60)} 分钟，全程约 ${Math.trunc((head.arriveSec - head.startSec) / 60)} 分钟）`
    : `最晚出发 <em>${formatTime(head.boardSec)}</em> 从「${opts.from}」上车（全程约 ${Math.trunc((head.arriveSec - head.boardSec) / 60)} 分钟，${formatTime(head.arriveSec)} 到达，不晚于 ${formatTime(opts.arriveSec)}）`;
  summary.innerHTML = headText + (plans.length > 1 ? `　共 <em>${plans.length}</em> 条并列最快方案` : '');

  timeline.innerHTML = '';
  plans.forEach((plan, idx) => {
    if (plans.length > 1) {
      const title = document.createElement('div');
      title.className = 'plan-title';
      title.textContent = `方案 ${idx + 1}`;
      timeline.appendChild(title);
    }
    let legNo = 0;
    for (const row of plan.rows) {
      if (row.transfer) {
        const div = document.createElement('div');
        div.className = 'xfer';
        div.textContent = `◇ ${net.nameOfGid[row.gid]} 换乘（约 ${opts.transferMin.toFixed(0)} 分钟，${formatTime(row.platformSec)} 走到站台）`;
        timeline.appendChild(div);
        continue;
      }
      legNo++;
      const c = net.corridors.get(row.corridorId);
      const leg = document.createElement('div');
      leg.className = 'leg';
      const legHead = document.createElement('div');
      legHead.className = 'leg-head';
      legHead.innerHTML = `<span class="leg-no">${plans.length > 1 ? `${idx + 1}.${legNo}` : legNo}.</span><span class="badge">${corridorName(c)}</span>`
        + `<span>往${row.dir === 0 ? c.d0Label : c.d1Label}</span>`
        + `<strong>${formatTime(row.boardSec)}</strong><span>${net.nameOfGid[row.stopGids[0]]} 上车</span>`;
      leg.appendChild(legHead);
      const stops = document.createElement('div');
      stops.className = 'stops';
      stops.innerHTML = row.stopGids.map((gid, i) => (i === 0
        ? net.nameOfGid[gid]
        : ` → ${net.nameOfGid[gid]}<span class="t">${formatTime(row.stopArriveSec[i - 1])}</span>`)).join('');
      leg.appendChild(stops);
      timeline.appendChild(leg);
    }
    const st = planStats(plan, Math.round(opts.transferMin * 60));
    const stats = document.createElement('div');
    stats.className = 'xfer';
    stats.textContent = `经由 ${st.stops} 站 / 换乘 ${st.transfers} 次 / 换乘候车合计 ${Math.trunc(st.gap / 60)} 分钟`;
    timeline.appendChild(stats);
  });

  $('details').hidden = false;
  $('textOut').textContent = plans.map((p, i) => (plans.length > 1 ? `方案 ${i + 1}\n` : '') + renderText(net, p, opts)).join('\n\n');
}

async function run() {
  const st = $('status');
  const from = fromInput.value.trim(), to = toInput.value.trim();
  const weekday = +$('weekday').value;
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const runMin = +$('runMin').value, transferMin = +$('transferMin').value;
  let timeSec;
  try {
    timeSec = parseTime($('time').value);
    if (!(runMin > 0 && runMin <= 30)) throw new Error('站间运行应在 (0, 30] 之间');
    if (!(transferMin >= 0 && transferMin <= 60)) throw new Error('换乘耗时应在 [0, 60] 之间');
  } catch (e) {
    st.className = 'status err';
    st.textContent = e.message;
    return;
  }

  $('go').disabled = true;
  try {
    const net = await networkFor(weekday);
    const f = net.gid(from), t = net.gid(to);
    if (f === null) return fail(`未找到车站「${from}」`, net.suggest(from));
    if (t === null) return fail(`未找到车站「${to}」`, net.suggest(to));

    const router = new Router(net, Math.round(runMin * 60), Math.round(transferMin * 60));
    const opts = { from, to, weekday, runMin, transferMin, departSec: null, arriveSec: null };
    let plans;
    if (mode === 'depart') { opts.departSec = timeSec; plans = router.routeDepartAll(f, t, timeSec); }
    else { opts.arriveSec = timeSec; plans = router.routeArriveAll(f, t, timeSec); }

    renderPlan(net, plans, opts);
    $('result').hidden = false;
    st.className = 'status';
    st.textContent = `周${'一二三四五六日'[weekday - 1]} ${plans.length === 0 ? '无结果' : `查询完成，${plans.length} 条并列最快方案`}`;
  } catch (e) {
    fail(String(e.message ?? e));
  } finally {
    $('go').disabled = false;
  }
}

$('form').addEventListener('submit', (e) => { e.preventDefault(); run(); });
for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener('change', () => {
    $('timeLabel').textContent = document.querySelector('input[name="mode"]:checked').value === 'depart' ? '出发时刻' : '最晚到达时刻';
  });
}

raw = await getJson('data/network.json');
// 每次打开/刷新都用当前星期与时刻，避免浏览器恢复上次输入导致时间过期
const pad = (n) => String(n).padStart(2, '0');
const resetNow = () => {
  const now = new Date();
  $('weekday').value = String(weekdayOf(now));
  $('time').value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
};
resetNow();
// 浏览器可能在 pageshow 之后恢复表单状态，稍后再设一次以覆盖
window.addEventListener('pageshow', () => requestAnimationFrame(resetNow));
requestAnimationFrame(resetNow);
const stationNames = [...raw.stations.map((s) => s[2])].filter((v, i, a) => a.indexOf(v) === i);
attachSuggest(fromInput, fromInput.nextElementSibling, () => stationNames);
attachSuggest(toInput, toInput.nextElementSibling, () => stationNames);
$('dataNote').textContent = `时刻表数据快照: ${raw.snapshot}（抓取自时刻表网站；要更新需本地重新抓取后重新部署）`;
$('status').textContent = '就绪';
