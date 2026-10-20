// 对拍：JS 引擎输出 vs timetable 的 Java CLI 输出，逐字符比较。
// 用法: node tools/verify-metro.mjs
// Java 源码优先用仓库内的 timetable/（CI 场景），其次用同级的 ../timetable/（本地开发场景）。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Network, Router } from '../metro/engine.js';
import { renderText } from '../metro/render.js';

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, '..');
const javaDir = existsSync(join(siteRoot, 'timetable'))
  ? join(siteRoot, 'timetable')
  : join(siteRoot, '..', 'timetable');
const dataDir = join(here, '..', 'metro', 'data');
const raw = JSON.parse(readFileSync(join(dataDir, 'network.json'), 'utf8'));
const tablesByWeekday = new Map();

function netFor(weekday) {
  if (!tablesByWeekday.has(weekday)) {
    const d = JSON.parse(readFileSync(join(dataDir, `tt_w${weekday}.json`), 'utf8'));
    tablesByWeekday.set(weekday, d.tables);
  }
  return Network.load(raw, tablesByWeekday.get(weekday));
}

const QUERIES = [];
const pairs = [
  ['木渎', '桑田岛'], ['苏州火车站', '东方之门'], ['木渎', '花桥'], ['临顿路', '唯亭'],
  ['苏州新区火车站', '钟南街'], ['广济南路', '金枫路'], ['狮子山', '苏州奥体中心'], ['乐桥', '乐桥'],
];
for (const [from, to] of pairs) {
  QUERIES.push({ from, to, depart: '08:30', weekday: 3 });
  QUERIES.push({ from, to, arrive: '09:30', weekday: 3 });
}
QUERIES.push({ from: '木渎', to: '桑田岛', depart: '05:10', weekday: 1 });
QUERIES.push({ from: '木渎', to: '桑田岛', arrive: '00:30', weekday: 7 });
QUERIES.push({ from: '木渎', to: '桑田岛', depart: '08:30', weekday: 5, runMin: 2.5, transferMin: 8 });
QUERIES.push({ from: '花桥', to: '木渎', depart: '22:40', weekday: 6 });

const sec = (s) => {
  const [h, m, ss] = s.split(':').map(Number);
  return h * 3600 + m * 60 + (ss || 0);
};

let pass = 0, fail = 0;
for (const q of QUERIES) {
  const args = ['route', '--from', q.from, '--to', q.to,
    '--cache-dir', join(javaDir, 'temp', 'cache'), '--weekday', String(q.weekday ?? 3)];
  if (q.depart) args.push('--depart', q.depart); else args.push('--arrive', q.arrive);
  if (q.runMin) args.push('--run-min', String(q.runMin));
  if (q.transferMin) args.push('--transfer-min', String(q.transferMin));

  const javaOut = execFileSync('java', ['-cp', join(javaDir, 'temp', 'classes'), 'szmetro.Main', ...args],
    { cwd: javaDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, '\n').trimEnd();

  const weekday = q.weekday ?? 3;
  const runMin = q.runMin ?? 2.0, transferMin = q.transferMin ?? 5.0;
  const net = netFor(weekday);
  const router = new Router(net, Math.round(runMin * 60), Math.round(transferMin * 60));
  const from = net.gid(q.from), to = net.gid(q.to);
  const plan = from === null || to === null ? null
    : q.depart ? router.routeDepart(from, to, sec(q.depart)) : router.routeArrive(from, to, sec(q.arrive));
  const jsOut = renderText(net, plan, {
    from: q.from, to: q.to, weekday, runMin, transferMin,
    departSec: q.depart ? sec(q.depart) : null, arriveSec: q.arrive ? sec(q.arrive) : null,
  });

  if (javaOut === jsOut) {
    pass++;
    console.log(`OK   ${q.from}→${q.to} ${q.depart ?? q.arrive} w${weekday}${q.runMin ? ` run${q.runMin}` : ''}${q.transferMin ? ` xfer${q.transferMin}` : ''}`);
  } else {
    fail++;
    console.log(`FAIL ${q.from}→${q.to} ${q.depart ?? q.arrive} w${weekday}`);
    const a = javaOut.split('\n'), b = jsOut.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        console.log(`  java: ${a[i] ?? '<缺行>'}`);
        console.log(`  js  : ${b[i] ?? '<缺行>'}`);
        break;
      }
    }
  }
}
console.log(`\n${pass} 通过 / ${fail} 失败（共 ${QUERIES.length}）`);
process.exit(fail === 0 ? 0 : 1);
