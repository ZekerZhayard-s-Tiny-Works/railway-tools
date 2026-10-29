// 路路通数据自检：加载引擎、校验数据规模、跑几条样本查询。
// 供定时任务在提交前确认下载到的是完整可用数据（不是残缺包或空文件）。
// 用法: node tools/verify-transfer-data.mjs [dataDir]
// 退出码: 0 通过；1 不通过。
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TransferEngine, formatResult } from '../transfer/engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.argv[2] ?? join(here, '..', 'transfer', 'data');

// 下限取当前规模（车站 3326 / 车次 13745 / 乘车边 813406）的约九成，运力增加不受影响
const MIN_STATIONS = 3000;
const MIN_TRAINS = 12000;
const MIN_RIDES = 700000;

const readBytes = async (name) => {
  const p = join(dataDir, name);
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
};
const readText = async (name) => {
  const p = join(dataDir, name);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};

const engine = await TransferEngine.load(readBytes, readText);
console.log(engine.statusLine());

const problems = [];
if (engine.stationNames.length < MIN_STATIONS) problems.push(`车站 ${engine.stationNames.length} < ${MIN_STATIONS}`);
if (engine.trainNames.length < MIN_TRAINS) problems.push(`车次 ${engine.trainNames.length} < ${MIN_TRAINS}`);
if (engine.rides.total < MIN_RIDES) problems.push(`乘车边 ${engine.rides.total} < ${MIN_RIDES}`);

const sl = await readText('sl.json');
const osm = await readText('osm_stations.tsv');
console.log(engine.configureWalk(true, 20, 30, sl, osm, `${dataDir}|walk`));

// 样本查询：只要求能算出方案，不比对具体时刻（时刻表会随调图变化）
// 查询日期取数据包版本号（形如 20261105），它一定落在该数据包覆盖的日期范围内
const verDate = /^(\d{8})$/.exec(engine.ver)?.[1] ?? (() => {
  const d = new Date(Date.now() + 3 * 86400000);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
})();
const SAMPLES = [
  ['北京', '上海', '出发'],
  ['上海虹桥', '广州南', '到达'],
  ['三亚', '阿克陶', '出发'],
];
for (const [from, to, mode] of SAMPLES) {
  const stamp = `${verDate}0800`;
  const result = engine.search(from, to, stamp, mode === '出发', 10);
  if (result === null || result.legs.length === 0) {
    problems.push(`样本查询无方案: ${from}→${to}（${stamp} ${mode}）`);
  } else {
    const head = formatResult(engine, result).split('\n').slice(1, 3).join('；');
    console.log(`OK   ${from}→${to} ${mode}：${head}`);
  }
}

if (problems.length) {
  console.error(`\n数据自检未通过:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\n数据自检通过');
