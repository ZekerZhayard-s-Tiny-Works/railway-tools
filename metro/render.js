// 结果文本渲染：与 timetable 的 Main.java 输出逐字一致，用作对拍基准与网页的文本视图。
import { planStats, corridorName, formatTime } from './engine.js';

export const DATA_SOURCE = 'http://106.14.198.252:8512';
const WEEKDAY_CHARS = '一二三四五六日';

/** opts: {from, to, weekday, departSec?, arriveSec?, runMin, transferMin} */
export function renderText(net, plan, opts) {
  const { from, to, weekday, runMin, transferMin } = opts;
  const wdName = `周${WEEKDAY_CHARS[weekday - 1]}`;
  const out = [];
  const sep = (ch) => ch + ch.repeat(28);

  out.push(sep('＝'));
  const mode = opts.departSec != null ? '后出发' : '前到达';
  const when = formatTime(opts.departSec != null ? opts.departSec : opts.arriveSec);
  out.push(`查询: ${from} → ${to}（${wdName} ${when} ${mode}，站间 ${runMin.toFixed(1)} 分钟 / 换乘 ${transferMin.toFixed(0)} 分钟）`);
  out.push(`（时刻表: ${DATA_SOURCE} ；站间运行与换乘时间为估计参数，`);
  out.push('  多条可行经由时按 时间 → 换乘候车余量合计最长 → 换乘次数最少 取舍，结果仅供参考）');
  const name = (gid) => net.nameOfGid[gid];
  if (plan === null) {
    out.push(opts.departSec != null
      ? '结果: 当日无可达路线（相关车站/方向当日无列车服务，或换乘链断裂）'
      : `结果: 当日无法在 ${formatTime(opts.arriveSec)} 前到达`);
    return out.join('\n');
  }
  out.push(sep('＝'));

  if (opts.departSec != null) {
    out.push(`最早到达: ${formatTime(plan.arriveSec)}（${formatTime(plan.startSec)} 到站台，候车 ${Math.trunc((plan.boardSec - plan.startSec) / 60)} 分钟，全程约 ${Math.trunc((plan.arriveSec - plan.startSec) / 60)} 分钟）`);
  } else {
    out.push(`最晚出发: ${formatTime(plan.boardSec)} 从「${from}」上车（全程约 ${Math.trunc((plan.arriveSec - plan.boardSec) / 60)} 分钟，${formatTime(plan.arriveSec)} 到达，不晚于 ${formatTime(opts.arriveSec)}）`);
  }
  out.push(sep('－'));

  let legNo = 0;
  for (const row of plan.rows) {
    if (row.transfer) {
      out.push(`  ◇ ${name(row.gid)} 换乘（约 ${transferMin.toFixed(0)} 分钟，${formatTime(row.platformSec)} 走到站台）`);
      continue;
    }
    legNo++;
    const c = net.corridors.get(row.corridorId);
    const toward = row.dir === 0 ? c.d0Label : c.d1Label;
    let s = '';
    for (let i = 0; i < row.stopGids.length; i++) {
      if (i > 0) s += ' → ';
      s += name(row.stopGids[i]);
      if (i > 0) s += ` ${formatTime(row.stopArriveSec[i - 1])}`;
    }
    out.push(`  ${legNo}. 乘${corridorName(c)}（往${toward}）${formatTime(row.boardSec)} ${name(row.stopGids[0])} 上车`);
    out.push(`  ${s}`);
  }
  out.push(sep('－'));
  const st = planStats(plan, Math.round(transferMin * 60));
  out.push(`经由 ${st.stops} 站 / 换乘 ${st.transfers} 次 / 换乘候车合计 ${Math.trunc(st.gap / 60)} 分钟`);
  return out.join('\n');
}
