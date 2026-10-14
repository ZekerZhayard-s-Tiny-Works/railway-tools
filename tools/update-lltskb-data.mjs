// 从路路通数据源更新站点用的时刻表数据（只取引擎需要的文件，纯 Node 解压）。
// 用法: node tools/update-lltskb-data.mjs [outDir]
import { writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const VERSION_URL = 'http://down.lltskb.com/android.ver';
const NEEDED = ['s.i', 't.i', 't.rule', 'ver.txt', ...Array.from({ length: 20 }, (_, i) => `T${i}.dat`)];

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ?? join(here, '..', 'transfer', 'data');

const verText = await (await fetch(VERSION_URL)).text();
const dataVersion = /"version"\s*:\s*\{.*?"data"\s*:\s*"(\d+)"/s.exec(verText)?.[1];
const urls = [...(/"dataUrl"\s*:\s*\[(.*?)]/s.exec(verText)?.[1] ?? '').matchAll(/"(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
if (!dataVersion || urls.length === 0) throw new Error('无法解析版本信息');

const localVer = (() => {
  try { return readFileSync(join(outDir, 'ver.txt'), 'utf8').replace(/^\uFEFF/, '').trim(); } catch { return ''; }
})();
console.log(`远端数据版本 ${dataVersion}，本地 ${localVer || '(无)'}`);

const num = (s) => s.replace(/\D/g, '').padStart(12, '0');
if (num(dataVersion) <= num(localVer)) {
  console.log('本地已是最新，无需更新');
  process.exit(0);
}

let zip = null, lastErr = null;
for (const url of urls) {
  try {
    console.log(`下载 ${url}`);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    zip = Buffer.from(await r.arrayBuffer());
    break;
  } catch (e) { lastErr = e; }
}
if (zip === null) throw new Error(`数据下载失败: ${lastErr?.message}`);

// 最小 ZIP 读取：遍历中央目录，取出需要的条目（stored / deflate）
const entries = new Map();
for (let i = zip.length - 22; i >= 0; i--) {
  if (zip.readUInt32LE(i) !== 0x06054b50) continue;
  let p = zip.readUInt32LE(i + 16);
  const count = zip.readUInt16LE(i + 10);
  for (let n = 0; n < count; n++) {
    const nameLen = zip.readUInt16LE(p + 28), extraLen = zip.readUInt16LE(p + 30), commentLen = zip.readUInt16LE(p + 32);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20), localOff = zip.readUInt32LE(p + 42);
    const localNameLen = zip.readUInt16LE(localOff + 26), localExtraLen = zip.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const raw = zip.subarray(dataStart, dataStart + compSize);
    entries.set(name.replace(/^.*\//, '').toLowerCase(), method === 0 ? raw : inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  break;
}

mkdirSync(outDir, { recursive: true });
const written = [];
for (const want of NEEDED) {
  const key = want.toLowerCase();
  const data = entries.get(key) ?? entries.get(key.replace('.', '_'));   // 数据包里索引也可能叫 s_i / t_i
  if (!data) { console.log(`跳过（数据包中没有）: ${want}`); continue; }
  writeFileSync(join(outDir, want), data);
  written.push(want);
}
for (const core of ['s.i', 't.i', 'T0.dat']) {
  if (!written.includes(core)) throw new Error(`解压结果缺少核心文件: ${core}`);
}
console.log(`已更新 ${written.length} 个文件到 ${outDir}: ${written.join(' ')}`);
