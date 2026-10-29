// 校验缓存时刻表与网站实时显示是否一致。
// 依据缓存文件头里的 src（抓取时实际使用的线路）复现同一请求，再逐小时比对"小时→分钟"茎叶图。
//
// 用法:
//   node tools/verify-metro-live.mjs                      # 全部星期、全部车站
//   node tools/verify-metro-live.mjs --weekday 1           # 只查某天
//   node tools/verify-metro-live.mjs --limit 20            # 只抽查前 20 个站（快速自检）
//   node tools/verify-metro-live.mjs --cache-dir <路径> --concurrency 3
//
// 退出码: 0 全部一致；1 存在差异或请求失败。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';

const BASE = process.env.SZMETRO_BASE ?? 'http://106.14.198.252:8512';
const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, '..');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith('--')) throw new Error(`无法识别参数: ${process.argv[i]}`);
  args.set(process.argv[i], process.argv[i + 1]);
}

const cacheDir = args.get('--cache-dir') ?? [
  join(siteRoot, 'timetable', 'temp', 'cache'),
  join(siteRoot, '..', 'timetable', 'temp', 'cache'),
].find((d) => existsSync(d));
if (!cacheDir) throw new Error('找不到抓取缓存目录，请用 --cache-dir 指定');
const concurrency = Number(args.get('--concurrency') ?? 3);
const limit = Number(args.get('--limit') ?? Infinity);
const maxReport = Number(args.get('--max-report') ?? 20);
const weekdays = args.get('--weekday')
  ? args.get('--weekday').split(',').map(Number)
  : [1, 2, 3, 4, 5, 6, 7];
const corridors = args.get('--corridor') ? new Set(args.get('--corridor').split(',').map(Number)) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 请求 /scheduling；302 表示该站不属于该线路（或 Cookie 被拒） */
function fetchScheduling(line, station, weekday, dir, attempt = 0) {
  const cookie = `line=${line}; station=${encodeURIComponent(station)}; weekday=${weekday}; direction=${dir}`;
  return new Promise((resolve, reject) => {
    const req = request({ host: '106.14.198.252', port: 8512, path: '/scheduling', method: 'GET',
      headers: { Cookie: cookie, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Connection: 'close' } },
    (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        if (res.statusCode === 200) return resolve(body);
        if (res.statusCode === 302) return reject(new Error(`HTTP 302（站名不属于 line=${line}，或 Cookie 被拒）`));
        reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('请求超时')));
    req.on('error', async (e) => {
      if (attempt < 2) {
        await sleep(500 * (attempt + 1));
        resolve(fetchScheduling(line, station, weekday, dir, attempt + 1));
      } else reject(e);
    });
    req.end();
  });
}

// 与 Crawler.java 的正则保持一致
const TAB_ROW = /<div class="tab-item">\s*<div class="tab-item-left">(\d+)<\/div>\s*<div class="tab-item-right"[^>]*>([\s\S]*?)<\/div>/g;
const TOKEN = /\d{1,2}/g;
const DIR_LABEL = /v-direction="(\d)"[^>]*>\s*([^<]+?)\s*</g;
const ACTIVE_DIR = /box-item-active[^"]*"\s*v-direction="(\d)"/;

function parseLabels(html) {
  const lab = [null, null];
  for (const m of html.matchAll(DIR_LABEL)) {
    const d = Number(m[1]);
    if (d === 0 || d === 1) lab[d] = m[2];
  }
  return `0:${lab[0]}|1:${lab[1]}`;
}

function parseLive(html) {
  const byHour = new Map();
  for (const m of html.matchAll(TAB_ROW)) {
    const hour = Number(m[1]);
    if (hour < 0 || hour > 47) continue;
    const mins = new Set();
    for (const t of m[2].matchAll(TOKEN)) {
      const v = Number(t[0]);
      if (v >= 0 && v <= 59) mins.add(v);
    }
    if (!byHour.has(hour)) byHour.set(hour, new Set());
    for (const v of mins) byHour.get(hour).add(v);
  }
  return byHour;
}

/** 缓存文件: 头部 "# ok=1 labels=0:X|1:Y src=d0=L1;d1=L1"，数据行 "dir\thour\t分钟..." */
function parseCache(text) {
  const meta = { ok: false, labels: null, src: new Map(), byDir: new Map([[0, new Map()], [1, new Map()]]) };
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    if (raw.startsWith('#')) {
      meta.ok = /ok=(\d)/.exec(raw)?.[1] === '1';
      meta.labels = /labels=(\S+)/.exec(raw)?.[1] ?? null;
      const src = /src=(\S+)/.exec(raw)?.[1];
      if (src) {
        for (const part of src.split(';')) {
          const m = /^d(\d)=L(\d+)$/.exec(part);
          if (m) meta.src.set(Number(m[1]), Number(m[2]));
        }
      }
      continue;
    }
    const p = raw.trim().split('\t');
    const dir = Number(p[0]), hour = Number(p[1]);
    if ((dir !== 0 && dir !== 1) || hour < 0 || hour > 47) continue;
    const set = meta.byDir.get(dir).get(hour) ?? new Set();
    for (let i = 2; i < p.length; i++) set.add(Number(p[i]));
    meta.byDir.get(dir).set(hour, set);
  }
  return meta;
}

const stations = new Map(); // 走廊 -> [{idx, line, name}]
for (const ln of readFileSync(join(cacheDir, 'stations.txt'), 'utf8').split(/\r?\n/)) {
  if (!ln.trim()) continue;
  const p = ln.split('\t');
  const cid = Number(p[0]);
  if (!stations.has(cid)) stations.set(cid, []);
  stations.get(cid).push({ idx: Number(p[1]), line: Number(p[2]), name: p[3] });
}

const tasks = [];
for (const weekday of weekdays) {
  for (const file of readdirSync(cacheDir)) {
    if (!file.startsWith('tt_') || !file.endsWith(`_w${weekday}.txt`)) continue;
    const [cid, idx] = file.slice(3, -4).split('_').map(Number);
    if (corridors && !corridors.has(cid)) continue;
    const stop = stations.get(cid)?.find((s) => s.idx === idx);
    if (!stop) continue;
    const meta = parseCache(readFileSync(join(cacheDir, file), 'utf8'));
    for (const dir of [0, 1]) {
      const line = meta.src.get(dir);
      // 没有 src 说明抓取时两个方向都没拿到数据（终点站常见），网站本来也没有内容，跳过
      if (line === undefined) continue;
      tasks.push({ file, cid, idx, weekday, dir, line, name: stop.name, meta });
    }
  }
}

const picked = tasks.slice(0, limit);
const total = picked.length;
console.log(`缓存目录: ${cacheDir}`);
console.log(`待校验 ${total} 个"车站×方向"（共发现 ${tasks.length} 个有数据的组合），并发 ${concurrency}\n`);

const diffs = [];
const errors = [];
let done = 0;

async function check(t) {
  const html = await fetchScheduling(t.line, t.name, t.weekday, t.dir);
  const active = ACTIVE_DIR.exec(html);
  if (active && Number(active[1]) !== t.dir) {
    throw new Error(`网站返回的方向是 ${active[1]}，与请求的 ${t.dir} 不符`);
  }
  const liveLabels = parseLabels(html);
  if (t.meta.labels && liveLabels !== t.meta.labels) {
    throw new Error(`方向标签不符: 缓存 ${t.meta.labels} / 网站 ${liveLabels}`);
  }
  const live = parseLive(html);
  const cached = t.meta.byDir.get(t.dir);
  const hours = [...new Set([...live.keys(), ...cached.keys()])].sort((a, b) => a - b);
  const bad = [];
  for (const h of hours) {
    const a = [...(cached.get(h) ?? [])].sort((x, y) => x - y);
    const b = [...(live.get(h) ?? [])].sort((x, y) => x - y);
    if (a.join(',') !== b.join(',')) bad.push({ hour: h, cached: a, live: b });
  }
  if (bad.length) diffs.push({ ...t, bad });
}

async function worker(queue) {
  for (;;) {
    const t = queue.shift();
    if (!t) return;
    try {
      await check(t);
    } catch (e) {
      errors.push({ ...t, message: e.message });
    }
    done++;
    if (done % 100 === 0) console.log(`已校验 ${done}/${total}…`);
    await sleep(80);
  }
}

const queue = [...picked];
await Promise.all(Array.from({ length: concurrency }, () => worker(queue)));

for (const d of diffs.slice(0, maxReport)) {
  console.log(`DIFF 星期${d.weekday} 走廊${d.cid} 站序${d.idx} ${d.name} 方向${d.dir}（line=${d.line}）`);
  for (const b of d.bad.slice(0, 3)) {
    console.log(`   ${String(b.hour).padStart(2, '0')} 时  缓存=[${b.cached.join(' ')}]  网站=[${b.live.join(' ')}]`);
  }
  if (d.bad.length > 3) console.log(`   …另有 ${d.bad.length - 3} 个小时不一致`);
}
for (const e of errors.slice(0, maxReport)) {
  console.log(`FAIL 星期${e.weekday} 走廊${e.cid} 站序${e.idx} ${e.name} 方向${e.dir}: ${e.message}`);
}
if (diffs.length > maxReport) console.log(`…差异过多，仅显示前 ${maxReport} 条`);
if (errors.length > maxReport) console.log(`…失败过多，仅显示前 ${maxReport} 条`);

const okCount = picked.length - diffs.length - errors.length;
if (diffs.length) {
  const tally = (key) => {
    const m = new Map();
    for (const d of diffs) m.set(d[key], (m.get(d[key]) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ');
  };
  console.log(`差异分布（星期） ${tally('weekday')}`);
  console.log(`差异分布（走廊） ${tally('cid')}`);
}
console.log(`\n一致 ${okCount} / 差异 ${diffs.length} / 失败 ${errors.length}（共 ${picked.length}）`);
process.exit(diffs.length === 0 && errors.length === 0 ? 0 : 1);
