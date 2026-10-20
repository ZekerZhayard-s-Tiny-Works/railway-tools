// 把 timetable 项目的抓取缓存 (temp/cache) 转换成站点用的 JSON。
// 用法: node tools/build-metro-data.mjs [cacheDir] [outDir] [--min-stops N] [--min-departures N]
// 给了阈值时，任一星期站次或总班次低于阈值即以非零退出（供定时任务判定抓取异常）。
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, '..');
const positional = [];
const flags = new Map();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) flags.set(argv[i], argv[++i]);
  else positional.push(argv[i]);
}
const flag = (name) => flags.get(name);
// 抓取缓存优先用仓库内的 timetable/（CI 场景），其次用同级的 ../timetable/（本地开发场景）
const cacheDir = positional[0] ?? (existsSync(join(siteRoot, 'timetable', 'temp', 'cache'))
  ? join(siteRoot, 'timetable', 'temp', 'cache')
  : join(siteRoot, '..', 'timetable', 'temp', 'cache'));
const outDir = positional[1] ?? join(siteRoot, 'metro', 'data');
const minStops = Number(flag('--min-stops') ?? 0);
const minDepartures = Number(flag('--min-departures') ?? 0);

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

// 数据快照时间取缓存文件里最新的一次抓取（按本地时区取日期，CI 里 TZ 设为 Asia/Shanghai）
const crawlTimes = [...ttFiles, 'stations.txt', 'official_pairs.txt'].map((f) => statSync(join(cacheDir, f)).mtimeMs);
const newest = new Date(Math.max(...crawlTimes));
const snapshot = `${newest.getFullYear()}-${String(newest.getMonth() + 1).padStart(2, '0')}-${String(newest.getDate()).padStart(2, '0')}`;

const weeks = [...byWeekday].sort((a, b) => a[0] - b[0]).map(([weekday, data]) => {
  const stops = Object.keys(data.tables);
  return { weekday, data, stops: stops.length, departures: stops.reduce((s, k) => s + data.tables[k][0].length + data.tables[k][1].length, 0) };
});

const problems = [];
for (const w of weeks) {
  if (w.stops < minStops) problems.push(`tt_w${w.weekday}: ${w.stops} 站次 < 下限 ${minStops}`);
  if (w.departures < minDepartures) problems.push(`tt_w${w.weekday}: ${w.departures} 班次 < 下限 ${minDepartures}`);
}
if (weeks.length !== 7) problems.push(`只生成了 ${weeks.length} 个星期（应为 7）`);
if (problems.length) {
  console.error(`抓取数据不完整，未写入任何文件:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
for (const w of weeks) {
  const out = join(outDir, `tt_w${w.weekday}.json`);
  writeFileSync(out, JSON.stringify(w.data));
  console.log(`tt_w${w.weekday}.json  ${w.stops} 站次 / ${w.departures} 班次  ${(readFileSync(out).length / 1024).toFixed(0)} KB`);
}
writeFileSync(join(outDir, 'network.json'), JSON.stringify({ snapshot, corridors, stations, labels, officialLines, officialPairs }));
console.log(`network.json  ${corridors.length} 走廊 / ${stations.length} 站 / ${officialPairs.length} 官网站对  ${(readFileSync(join(outDir, 'network.json')).length / 1024).toFixed(0)} KB  快照 ${snapshot}`);
