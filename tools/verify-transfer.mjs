// 对拍：JS 引擎 vs LulutongTransfer 的 Java CLI，结果文本与日志逐字符比较。
// 用法: node tools/verify-transfer.mjs [数据目录] [sl.json] [osm_stations.tsv]
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TransferEngine, formatResult } from '../transfer/engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const javaDir = join(root, 'LulutongTransfer');
const dataDir = process.argv[2] ?? join(root, 'scratch', 'llt-data');
const slPath = process.argv[3] ?? join(javaDir, 'sl.json');
const osmPath = process.argv[4] ?? join(javaDir, 'osm_stations.tsv');

const readBytes = async (name) => {
  const p = join(dataDir, name);
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
};
const readText = async (name) => {
  const p = join(dataDir, name);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};

// Java CLI 的 System.out/err 默认用平台编码（本机 GBK），管道里必须强制 UTF-8
const runJava = (args) => {
  const r = spawnSync('java', ['-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
    '-cp', join(javaDir, 'build', 'libs', 'LulutongTransfer.jar'),
    'lulutong.LulutongTransfer', ...args, '-data', dataDir],
    { cwd: javaDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { stdout: (r.stdout ?? '').replace(/\r\n/g, '\n').trimEnd(), stderr: (r.stderr ?? '').replace(/\r\n/g, '\n').trimEnd() };
};

const engine = await TransferEngine.load(readBytes, readText);
const sl = existsSync(slPath) ? readFileSync(slPath, 'utf8') : null;
const osm = existsSync(osmPath) ? readFileSync(osmPath, 'utf8') : null;
const jsStatus = engine.statusLine();
const jsWalk = engine.configureWalk(true, 20, 30, sl, osm, `${slPath}|${osmPath}`);

const javaLog = runJava(['-f', '北京', '-t', '上海', '-d', '202610150800', '-m', '10']).stderr.split('\n');
const logPairs = [[javaLog[0], jsStatus], [javaLog[javaLog.length - 1], jsWalk]];
let logFail = 0;
for (const [j, s] of logPairs) {
  if (j === s) console.log(`OK   ${j}`);
  else { logFail++; console.log(`FAIL 日志\n  java: ${j}\n  js  : ${s}`); }
}

const QUERIES = [
  ['三亚', '阿克陶', 'd', '202610150800', '15'],
  ['北京', '上海', 'd', '202610150800', '10'],
  ['上海虹桥', '广州南', 'a', '202610152000', '10'],
  ['北京西', '成都东', 'd', '202610160700', '12'],
  ['哈尔滨', '三亚', 'd', '202610170600', '20'],
  ['乌鲁木齐', '拉萨', 'd', '202610180900', '30'],
  ['广州', '武汉', 'a', '202610161200', '8'],
  ['深圳北', '西安北', 'd', '202610191000', '15'],
  ['重庆北', '昆明南', 'd', '202610200830', '10'],
  ['郑州', '济南西', 'a', '202610150900', '5'],
];

let pass = 0, fail = 0;
for (const [from, to, mode, time, minTransfer] of QUERIES) {
  const out = runJava(['-f', from, '-t', to, `-${mode}`, time, '-m', minTransfer]).stdout;

  const t0 = Date.now();
  const jsResult = engine.search(from, to, time, mode === 'd', Number(minTransfer));
  const jsOut = formatResult(engine, jsResult);
  const ms = Date.now() - t0;

  if (out === jsOut) {
    pass++;
    console.log(`OK   ${from}→${to} ${mode}${time} m${minTransfer}  (${ms}ms)`);
  } else {
    fail++;
    console.log(`FAIL ${from}→${to} ${mode}${time} m${minTransfer}`);
    const a = out.split('\n'), b = jsOut.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        console.log(`  java: ${a[i] ?? '<缺行>'}`);
        console.log(`  js  : ${b[i] ?? '<缺行>'}`);
        break;
      }
    }
  }
}
console.log(`\n${pass} 通过 / ${fail} 失败（共 ${QUERIES.length}），日志 ${logFail === 0 ? '一致' : '不一致'}`);
process.exit(fail === 0 && logFail === 0 ? 0 : 1);
