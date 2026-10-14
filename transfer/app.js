// 全国铁路中转换乘查询页面：加载路路通数据，跑搜索并渲染结果表格。
import { TransferEngine, formatResult, formatTime, formatDuration, trimNumPublic } from './engine.js';
import { attachSuggest } from '../suggest.js';

const $ = (id) => document.getElementById(id);
const DATA = 'data/';
const WEEKDAYS = '一二三四五六日';

let engine = null;
let stationNames = [];
let geo = { sl: null, osm: null };
let lastWalkLog = '';

const log = (msg) => {
  $('logCard').hidden = false;
  $('log').textContent += `${$('log').textContent ? '\n' : ''}${msg}`;
};
const setStatus = (msg, cls = 'status') => { $('status').className = cls; $('status').textContent = msg; };

const readBytes = async (name) => {
  const r = await fetch(DATA + name);
  return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
};
const readText = async (name) => {
  const r = await fetch(DATA + name);
  return r.ok ? r.text() : null;
};

async function loadEngine() {
  const t0 = Date.now();
  engine = await TransferEngine.load(readBytes, readText);
  stationNames = engine.allStations();
  log(`${engine.statusLine()}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
  attachSuggest($('from'), $('from').nextElementSibling, () => stationNames);
  attachSuggest($('to'), $('to').nextElementSibling, () => stationNames);
  setStatus('数据已就绪，输入出发站、到达站和时间后搜索');
  $('go').disabled = false;
}

async function ensureGeo() {
  if (geo.sl === null) geo.sl = (await readText('sl.json')) ?? '';
  if (geo.osm === null) geo.osm = (await readText('osm_stations.tsv')) ?? '';
}

function fail(message) {
  setStatus(message, 'status err');
  $('result').hidden = true;
}

function renderResult(result) {
  const summary = $('summary'), table = $('table');
  if (result === null || result.legs.length === 0) {
    summary.textContent = '未找到可行方案';
    table.innerHTML = '';
    $('details').hidden = true;
    return;
  }
  const legs = result.legs;
  const depart = legs[0].dep, arrive = legs[legs.length - 1].arr;
  let trains = 0, walks = 0, walkMinutes = 0, walkKm = 0, wait = 0;
  for (const l of legs) {
    if (l.walk) { walks++; walkMinutes += l.arr - l.dep; walkKm += l.km; } else trains++;
  }
  for (let i = 0; i + 1 < legs.length; i++) wait += legs[i + 1].dep - legs[i].arr;

  summary.textContent = `出发 ${formatTime(depart)} ${engine.stationName(legs[0].from)} → 到达 ${formatTime(arrive)} ${engine.stationName(legs[legs.length - 1].to)}　总历时 ${formatDuration(arrive - depart)}，换乘 ${Math.max(0, trains - 1)} 次`
    + (walks > 0 ? `，邻站接驳 ${walks} 次（约 ${trimNumPublic(Math.round(walkKm * 10) / 10)} 公里）` : '')
    + `，换乘等待合计 ${formatDuration(wait)}`
    + (walks > 0 ? `，接驳耗时合计 ${formatDuration(walkMinutes)}` : '');

  const rows = ['<thead><tr><th class="num">序号</th><th>车次</th><th>出发站</th><th>出发时间</th><th>到达站</th><th>到达时间</th><th>历时 / 距离</th><th>衔接</th></tr></thead><tbody>'];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const train = leg.walk ? '[邻站接驳]' : engine.trainName(engine.rides.trainId[leg.ride]);
    const dur = leg.walk ? `约${trimNumPublic(Math.round(leg.km * 10) / 10)}公里` : formatDuration(leg.arr - leg.dep);
    const link = i > 0 ? `衔接 ${formatDuration(leg.dep - legs[i - 1].arr)}` : '';
    rows.push(`<tr${leg.walk ? ' class="walk"' : ''}><td class="num">${i + 1}</td><td>${train}</td>`
      + `<td>${engine.stationName(leg.from)}</td><td>${formatTime(leg.dep)}</td>`
      + `<td>${engine.stationName(leg.to)}</td><td>${formatTime(leg.arr)}</td>`
      + `<td>${dur}</td><td>${link}</td></tr>`);
  }
  rows.push('</tbody>');
  table.innerHTML = rows.join('');

  $('details').hidden = false;
  $('textOut').textContent = formatResult(engine, result);
}

async function run() {
  const from = $('from').value.trim(), to = $('to').value.trim();
  const date = $('date').value, time = $('time').value;
  const departMode = document.querySelector('input[name="mode"]:checked').value === 'depart';
  const minTransfer = +$('minTransfer').value;
  const walkEnabled = $('walk').checked;
  const speed = +$('speed').value, maxDist = +$('maxDist').value;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return fail('请填写日期与时间');
  if (!(minTransfer >= 0)) return fail('换乘预留不能为负数');
  if (walkEnabled && !(speed > 0 && maxDist > 0)) return fail('接驳速度与最大距离必须为正数');

  $('go').disabled = true;
  try {
    if (walkEnabled) {
      setStatus('正在计算邻近车站…');
      await ensureGeo();
    }
    const walkLog = engine.configureWalk(walkEnabled, speed, maxDist, geo.sl, geo.osm, 'files');
    if (walkLog !== lastWalkLog) {
      lastWalkLog = walkLog;
      log(walkLog);
    }
    setStatus('正在搜索…');
    const stamp = `${date.replaceAll('-', '')}${time.replace(':', '')}`;
    const t0 = Date.now();
    const result = engine.search(from, to, stamp, departMode, minTransfer);
    renderResult(result);
    $('result').hidden = false;
    setStatus(`搜索完成（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
  } catch (e) {
    fail(String(e.message ?? e));
  } finally {
    $('go').disabled = false;
  }
}

$('form').addEventListener('submit', (e) => { e.preventDefault(); run(); });

const today = new Date();
const pad = (n) => String(n).padStart(2, '0');
$('date').value = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
$('time').value = `${pad(today.getHours())}:${pad(today.getMinutes())}`;
$('dataNote').textContent = '数据来源: down.lltskb.com 时刻表数据包';

loadEngine().catch((e) => {
  setStatus(`数据加载失败: ${e.message}`, 'status err');
  log(`数据加载失败: ${e.message}`);
});
