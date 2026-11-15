// 生成站名 -> 站层示意图地址映射（metro/data/stations-meta.json）。
// 官网 admin/stationInfo/getStationInfoById.do 返回 stationFloorPlanImg，
// 站号来自 stationInfo_zh.js。官网对境外 IP 返回 403，只能在本机运行。
// 用法: node tools/build-station-meta.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, '..');
const OUT = join(siteRoot, 'metro', 'data', 'stations-meta.json');
const HOST = 'https://www.sz-mtr.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 站名（与站点数据一致的写法）
const names = new Set(JSON.parse(readFileSync(join(siteRoot, 'metro', 'data', 'network.json'), 'utf8')).stations.map((s) => s[2]));

const src = await (await fetch(`${HOST}/service/guide/map/javascript/stationInfo_zh.js`)).text();
const idsByLine = new Map();   // 站名 -> [站号...]
for (const m of src.matchAll(/szmtr\.stations\["([^"]+)"\] = \{ name: "([^"]*)"/g)) {
  const key = m[1], name = m[2];
  const id = key.includes('_') ? key.split('_')[1] : key;   // 换乘站 sX_YYYY 取下划线后的站号
  if (!idsByLine.has(name)) idsByLine.set(name, []);
  if (!idsByLine.get(name).includes(id)) idsByLine.get(name).push(id);
}

// 站点数据里的站名可能与官网写法不同（如「陆慕/古巷」对「陆慕古巷」），按去斜杠后比对
const norm = (s) => s.replace(/\//g, '');
const byNorm = new Map();
for (const [name, ids] of idsByLine) {
  const k = norm(name);
  if (!byNorm.has(k)) byNorm.set(k, []);
  byNorm.get(k).push([...ids]);
}

async function fetchInfo(id) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${HOST}/admin/stationInfo/getStationInfoById.do`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0',
          Referer: `${HOST}/service/guide/stations/` },
        body: new URLSearchParams({ id }).toString(),
      });
      const text = await res.text();
      if (!text.trimStart().startsWith('{')) return null;   // 站号无效时返回 HTML
      return JSON.parse(text).data ?? null;
    } catch {
      await sleep(1500 * attempt);
    }
  }
  return null;
}

const meta = {};
const missing = [];
let done = 0;
for (const name of names) {
  const ids = idsByLine.get(name) ?? byNorm.get(norm(name))?.[0] ?? [];
  let img = null;
  for (const id of ids) {
    const data = await fetchInfo(id);
    await sleep(250);
    if (data?.stationFloorPlanImg) { img = data.stationFloorPlanImg; break; }
  }
  if (img) meta[name] = { img };
  else missing.push(name);
  if (++done % 25 === 0) console.log(`  ${done}/${names.size}…`);
}

const sorted = Object.fromEntries(Object.entries(meta).sort(([a], [b]) => a.localeCompare(b, 'zh')));
writeFileSync(OUT, JSON.stringify(sorted));
console.log(`\n写入 ${OUT}`);
console.log(`有站层图 ${Object.keys(sorted).length} / ${names.size} 站；无图 ${missing.length} 站`);
if (missing.length) console.log('无图站点:', missing.slice(0, 30).join('、'), missing.length > 30 ? '…' : '');
