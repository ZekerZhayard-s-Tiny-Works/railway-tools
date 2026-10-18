// 把 timetable 项目的抓取缓存 (temp/cache) 转换成站点用的 JSON。
// 用法: node tools/build-metro-data.mjs [cacheDir] [outDir]
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cacheDir = process.argv[2] ?? join(here, '..', '..', 'timetable', 'temp', 'cache');
const outDir = process.argv[3] ?? join(here, '..', 'metro', 'data');

const lines = (f) => readFileSync(join(cacheDir, f), 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');

// corridors.txt: 走廊号 \t 菜单线路号(逗号分隔)
const corridors = lines('corridors.txt').map((l) => {
  const p = l.split('\t');
  return [Number(p[0]), p[1].split(',').map(Number)];
});

// stations.txt: 走廊号 \t 站序 \t 站点号 \t 站名
const stations = lines('stations.txt').map((l) => {
  const p = l.split('\t');
  return [Number(p[0]), Number(p[1]), p[3].trim()];
});

// official_lines.txt: 线路名 \t 序号 \t 站名
const officialLines = lines('official_lines.txt').map((l) => {
  const p = l.split('\t');
  return [p[0], Number(p[1]), p[2]];
});

// official_pairs.txt: 线路名 \t 站A \t 站B \t A->B分钟 \t B->A分钟
const officialPairs = lines('official_pairs.txt').map((l) => {
  const p = l.split('\t');
  return [p[0], p[1], p[2], Number(p[3]) || 0, Number(p[4]) || 0];
});

// 时刻表: tt_{走廊}_{站序}_w{星期}.txt -> 按星期分文件 { "走廊|站序": {方向: [秒...]} }
// 方向标签（往某站）与星期无关，一并放进 network.json
const ttFiles = readdirSync(cacheDir).filter((f) => f.startsWith('tt_') && f.endsWith('.txt'));
const labels = {};
const byWeekday = new Map();
for (const f of ttFiles) {
  const [cid, idx, wTag] = f.slice(3, -4).split('_');
  const weekday = Number(wTag.slice(1));
  const dirs = [[], []];
  for (const ln of readFileSync(join(cacheDir, f), 'utf8').split(/\r?\n/)) {
    if (ln.trim() === '') continue;
    if (ln.startsWith('#')) {
      const li = ln.indexOf('labels=');
      if (li >= 0 && labels[cid] === undefined) labels[cid] = ln.slice(li + 7).trim().split(' ')[0];
      continue;
    }
    const p = ln.trim().split('\t');
    const dir = Number(p[0]);
    const hour = Number(p[1]);
    if (dir < 0 || dir > 1 || hour < 0 || hour > 47) continue;
    const secs = new Set(dirs[dir]);
    for (let i = 2; i < p.length; i++) secs.add(hour * 3600 + Number(p[i]) * 60);
    dirs[dir] = [...secs].sort((a, b) => a - b);
  }
  if (!byWeekday.has(weekday)) byWeekday.set(weekday, { tables: {} });
  byWeekday.get(weekday).tables[`${cid}|${idx}`] = dirs;
}

mkdirSync(outDir, { recursive: true });
// 数据快照时间取缓存文件里最新的一次抓取
const crawlTimes = [...ttFiles, 'stations.txt', 'official_pairs.txt'].map((f) => statSync(join(cacheDir, f)).mtimeMs);
const snapshot = new Date(Math.max(...crawlTimes)).toISOString().slice(0, 10);
writeFileSync(join(outDir, 'network.json'), JSON.stringify({ snapshot, corridors, stations, labels, officialLines, officialPairs }));

for (const [weekday, data] of [...byWeekday].sort((a, b) => a[0] - b[0])) {
  const stops = Object.keys(data.tables);
  const departures = stops.reduce((s, k) => s + data.tables[k][0].length + data.tables[k][1].length, 0);
  const out = join(outDir, `tt_w${weekday}.json`);
  writeFileSync(out, JSON.stringify(data));
  console.log(`tt_w${weekday}.json  ${stops.length} 站次 / ${departures} 班次  ${(readFileSync(out).length / 1024).toFixed(0)} KB`);
}
console.log(`network.json  ${corridors.length} 走廊 / ${stations.length} 站 / ${officialPairs.length} 官网站对  ${(readFileSync(join(outDir, 'network.json')).length / 1024).toFixed(0)} KB`);
