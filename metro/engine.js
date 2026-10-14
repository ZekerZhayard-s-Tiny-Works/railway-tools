// 苏州地铁路由引擎（Network.java / Router.java 的 JS 移植，浏览器与 Node 通用）。
// 数据由 tools/build-metro-data.mjs 从 timetable 项目的抓取缓存生成：
//   network.json = { corridors, stations, labels, officialLines, officialPairs }
//   tt_w{N}.json = { "走廊|站序": [方向0发车秒[], 方向1发车秒[]] }

export class Network {
  constructor() {
    this.corridors = new Map();          // cid -> {id, menuLineIds, stopGids, stopNames, d0Label, d1Label}
    this.gidOfName = new Map();
    this.nameOfGid = [];
    this.corridorsAtStation = new Map(); // gid -> [cid]（升序）
    this.dir0Step = new Map();
    this.pairMatrix = new Map();         // cid -> [i][j] = i 乘到 j 的秒数，-1 无数据
    this.tables = new Map();             // "cid|idx" -> [方向0秒[], 方向1秒[]]
  }

  static load(raw, weekTables) {
    const n = new Network();
    const corridors = [...raw.corridors].sort((a, b) => a[0] - b[0]);
    const corMenuLines = new Map(corridors);

    const ordered = new Map();
    for (const [cid, idx, name] of raw.stations) {
      let sts = ordered.get(cid);
      if (!sts) ordered.set(cid, (sts = []));
      if (idx !== sts.length) throw new Error(`走廊 ${cid} 站点序号不连续: ${name}`);
      sts.push(name);
    }

    for (const [cid] of [...ordered.entries()].sort((a, b) => a[0] - b[0])) {
      const names = ordered.get(cid);
      const gids = names.map((name) => {
        let gid = n.gidOfName.get(name);
        if (gid === undefined) {
          gid = n.nameOfGid.length;
          n.gidOfName.set(name, gid);
          n.nameOfGid.push(name);
        }
        let at = n.corridorsAtStation.get(gid);
        if (!at) n.corridorsAtStation.set(gid, (at = []));
        if (!at.includes(cid)) at.push(cid);
        return gid;
      });
      n.corridors.set(cid, {
        id: cid, menuLineIds: corMenuLines.get(cid) ?? [],
        stopGids: gids, stopNames: names, d0Label: null, d1Label: null,
      });
    }
    for (const at of n.corridorsAtStation.values()) at.sort((a, b) => a - b);

    n.tables = new Map(Object.entries(weekTables));

    // 方向 0 的站序步长：标签是走廊末站则 +1，是首站则 -1
    for (const [cid, c] of n.corridors) {
      const lab = (raw.labels ?? {})[cid];
      const l0 = lab ? lab.split('|').find((s) => s.startsWith('0:'))?.slice(2).trim() ?? null : null;
      const l1 = lab ? lab.split('|').find((s) => s.startsWith('1:'))?.slice(2).trim() ?? null : null;
      let step;
      if (l0 == null) {
        step = 0;
      } else if (l0 === c.stopNames[c.stopNames.length - 1]) {
        step = 1;
      } else if (l0 === c.stopNames[0]) {
        step = -1;
      } else {
        throw new Error(`走廊 ${cid} 方向标签(${l0}/${l1})与车站端点(${c.stopNames[0]}/${c.stopNames[c.stopNames.length - 1]})不匹配`);
      }
      n.dir0Step.set(cid, step);
      c.d0Label = l0;
      c.d1Label = l1;
    }

    // 官网同线站对时间
    const offPos = new Map(), offPair = new Map();
    for (const [lineName, idx, name] of raw.officialLines) {
      let pos = offPos.get(lineName);
      if (!pos) { offPos.set(lineName, (pos = new Map())); offPair.set(lineName, []); }
      pos.set(name, idx);
      offPair.get(lineName)[idx] = name;
    }
    for (const [lineName, names] of offPair) {
      const sz = names.length;
      const tri = [];
      for (let i = 0; i < sz; i++) {
        tri.push([]);
        for (let j = 0; j < sz; j++) tri[i].push([0, 0]);
      }
      offPair.set(lineName, tri);
    }
    for (const [lineName, a, b, fwd, bwd] of raw.officialPairs) {
      const pos = offPos.get(lineName), tri = offPair.get(lineName);
      if (!pos || !tri) continue;
      const pi = pos.get(a), pj = pos.get(b);
      if (pi === undefined || pj === undefined || pi >= pj) continue;
      if (fwd) tri[pi][pj][0] = fwd * 60;
      if (bwd) tri[pi][pj][1] = bwd * 60;
    }

    // 每走廊构建站对时间矩阵
    for (const [cid, c] of n.corridors) {
      const names = c.stopNames;
      const sz = names.length;
      const mat = [];
      for (let i = 0; i < sz; i++) mat.push(new Array(sz).fill(-1));
      const corrLines = new Map(); // 官网线路名 -> {offIdx, sameDir}
      for (const menuLine of c.menuLineIds) {
        const lname = `${menuLine}号线`;
        const pos = offPos.get(lname);
        if (!pos) continue;
        const offIdx = new Map();
        let minCorr = Infinity, maxCorr = -1, firstOffIdx = -1, lastOffIdx = -1;
        const nOff = pos.size;
        for (const [name, offI] of pos) {
          const cIdx = names.indexOf(name);
          if (cIdx < 0) continue;
          offIdx.set(name, offI);
          if (offI === 0) firstOffIdx = cIdx;
          if (offI === nOff - 1) lastOffIdx = cIdx;
          if (cIdx < minCorr) minCorr = cIdx;
          if (cIdx > maxCorr) maxCorr = cIdx;
        }
        const sameDir = firstOffIdx < 0 || lastOffIdx < 0 ? minCorr <= maxCorr : firstOffIdx <= lastOffIdx;
        if (offIdx.size > 0) corrLines.set(lname, { offIdx, sameDir });
      }
      for (let i = 0; i < sz; i++) {
        for (let j = i + 1; j < sz; j++) {
          for (const [lname, cl] of corrLines) {
            const pi = cl.offIdx.get(names[i]), pj = cl.offIdx.get(names[j]);
            if (pi === undefined || pj === undefined || pi === pj) continue;
            const tri = offPair.get(lname);
            const hi = Math.min(pi, pj), lo = Math.max(pi, pj);
            const fwd = tri[hi][lo][0], bwd = tri[hi][lo][1];
            if (fwd <= 0 && bwd <= 0) continue;
            const ij = (pi < pj) === cl.sameDir ? fwd : bwd;
            const ji = (pi < pj) === cl.sameDir ? bwd : fwd;
            if (ij > 0) mat[i][j] = ij;
            if (ji > 0) mat[j][i] = ji;
            break;
          }
        }
      }
      n.pairMatrix.set(cid, mat);
    }
    return n;
  }

  /** 沿走廊从 fromIdx 乘到 toIdx 的秒数：官网站对优先，缺失退化为逐段累加 */
  elapsedSec(cid, fromIdx, toIdx, fallbackSec) {
    if (fromIdx === toIdx) return 0;
    const mat = this.pairMatrix.get(cid);
    if (mat && mat[fromIdx][toIdx] > 0) return mat[fromIdx][toIdx];
    return this.hopSum(cid, fromIdx, toIdx, fallbackSec);
  }

  /** 上车点 boardIdx 到第 k 站的累计秒数 */
  cumSec(cid, boardIdx, k, fallbackSec) {
    const mat = this.pairMatrix.get(cid);
    if (mat && mat[boardIdx][k] > 0) return mat[boardIdx][k];
    return this.hopSum(cid, boardIdx, k, fallbackSec);
  }

  hopSum(cid, fromIdx, toIdx, fallbackSec) {
    const step = toIdx > fromIdx ? 1 : -1;
    let total = 0;
    for (let i = fromIdx; i !== toIdx; i += step) {
      const mat = this.pairMatrix.get(cid);
      const v = mat ? mat[i][i + step] : -1;
      total += v > 0 ? v : fallbackSec;
    }
    return total;
  }

  table(cid, idx, dir) {
    const t = this.tables.get(`${cid}|${idx}`);
    return t ? t[dir] : [];
  }

  stepOf(cid, dir) {
    const s = this.dir0Step.get(cid) ?? 0;
    return dir === 0 ? s : -s;
  }

  stopIndex(cid, gid) {
    return this.corridors.get(cid).stopGids.indexOf(gid);
  }

  gid(name) {
    const g = this.gidOfName.get(String(name).trim());
    return g === undefined ? null : g;
  }

  suggest(input) {
    const q = String(input).trim();
    const out = [];
    if (!q) return out;
    for (const name of this.gidOfName.keys()) {
      if (name.includes(q) || q.includes(name) || commonPrefix(name, q) >= 2) out.push(name);
    }
    return out;
  }
}

function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

const START = -1;
const TYPE_START = 0, TYPE_RIDE = 1, TYPE_TRANSFER = 2;

/** 方案比较键：时间小者优 → 换乘候车余量合计大者优 → 换乘次数小者优 */
function cmpCost(a, b) {
  if (a.time !== b.time) return a.time - b.time;
  if (a.gap !== b.gap) return b.gap - a.gap;
  return a.count - b.count;
}

const key = (gid, corridor, afterTransfer) => gid * 128 + (corridor + 2) + (afterTransfer ? 64 : 0);
const keyGid = (k) => Math.floor(k / 128);
const keyCorridor = (k) => (k & 63) - 2;
const keyAfterTransfer = (k) => (k & 64) !== 0;

/** 最小堆（同 Java PriorityQueue + Cost 比较器） */
class Heap {
  constructor(cmp) { this.a = []; this.cmp = cmp; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(a[i], a[p]) >= 0) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0], last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

/** 发车时刻表查找：第一个 >= t 的时刻；无则 -1 */
function nextDeparture(sortedSec, t) {
  let lo = 0, hi = sortedSec.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedSec[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo < sortedSec.length ? sortedSec[lo] : -1;
}

export class Router {
  constructor(net, runSec, transferSec) {
    this.net = net;
    this.runSec = runSec;
    this.transferSec = transferSec;
  }

  /** 给定最早出发时刻，返回按字典序最优的方案；不可达返回 null */
  routeDepart(fromGid, toGid, startSec) {
    const net = this.net;
    if (fromGid === toGid) return { startSec, boardSec: startSec, arriveSec: startSec, rows: [] };

    const best = new Map(), parent = new Map();
    const pq = new Heap((x, y) => cmpCost(x.cost, y.cost));
    const startCost = { time: startSec, gap: 0, count: 0 };
    best.set(key(fromGid, START, false), startCost);
    pq.push({ cost: startCost, key: key(fromGid, START, false) });

    while (pq.size > 0) {
      const cur = pq.pop();
      if (best.get(cur.key) !== cur.cost) continue;
      const c = cur.cost, k = cur.key;
      const gid = keyGid(k);
      const corridor = keyCorridor(k);
      const afterTransfer = keyAfterTransfer(k);

      if (corridor === START) {
        for (const l of net.corridorsAtStation.get(gid) ?? []) {
          this.relax(best, parent, pq, key(gid, l, false), { time: c.time, gap: c.gap, count: c.count },
            { type: TYPE_START, fromKey: k, fromGid: gid, fromCorridor: START, corridorId: l, dir: -1, toGid: gid, departSec: c.time, arriveSec: c.time });
        }
      } else {
        const idx = net.stopIndex(corridor, gid);
        const stops = net.corridors.get(corridor).stopGids;
        for (let dir = 0; dir <= 1; dir++) {
          const dep = nextDeparture(net.table(corridor, idx, dir), c.time);
          if (dep < 0) continue;
          const gapAdd = afterTransfer ? dep - c.time : 0;
          const step = net.stepOf(corridor, dir);
          for (let nidx = idx + step; nidx >= 0 && nidx < stops.length; nidx += step) {
            const arrive = dep + net.elapsedSec(corridor, idx, nidx, this.runSec);
            this.relax(best, parent, pq, key(stops[nidx], corridor, false), { time: arrive, gap: c.gap + gapAdd, count: c.count },
              { type: TYPE_RIDE, fromKey: k, fromGid: gid, fromCorridor: corridor, corridorId: corridor, dir, toGid: stops[nidx], departSec: dep, arriveSec: arrive });
          }
        }
        for (const m of net.corridorsAtStation.get(gid) ?? []) {
          if (m === corridor) continue;
          this.relax(best, parent, pq, key(gid, m, true), { time: c.time + this.transferSec, gap: c.gap, count: c.count + 1 },
            { type: TYPE_TRANSFER, fromKey: k, fromGid: gid, fromCorridor: corridor, corridorId: m, dir: -1, toGid: gid, departSec: c.time, arriveSec: c.time + this.transferSec });
        }
      }
    }

    let bestKey = -1, bestCost = null;
    for (const [kk, cc] of best) {
      if (keyGid(kk) !== toGid) continue;
      if (bestCost === null || cmpCost(cc, bestCost) < 0) { bestCost = cc; bestKey = kk; }
    }
    if (bestKey < 0) return null;
    return this.buildPlan(parent, bestKey, startSec, bestCost.time);
  }

  /** 给定到达时限，返回"最晚出发仍不迟到"的方案；无法按时到达返回 null */
  routeArrive(fromGid, toGid, deadlineSec) {
    const net = this.net;
    const cands = new Set();
    for (const c of net.corridorsAtStation.get(fromGid) ?? []) {
      const idx = net.stopIndex(c, fromGid);
      for (let dir = 0; dir <= 1; dir++) for (const sec of net.table(c, idx, dir)) cands.add(sec);
    }
    if (cands.size === 0) return null;
    const cs = [...cands].sort((a, b) => a - b);

    const first = this.routeDepart(fromGid, toGid, cs[0]);
    if (first === null || first.arriveSec > deadlineSec) return null;

    let bestPlan = first;
    let lo = 0, hi = cs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = this.routeDepart(fromGid, toGid, cs[mid]);
      if (p !== null && p.arriveSec <= deadlineSec) { bestPlan = p; lo = mid + 1; } else { hi = mid - 1; }
    }
    return bestPlan;
  }

  relax(best, parent, pq, nKey, nc, e) {
    const old = best.get(nKey);
    if (old !== undefined && cmpCost(old, nc) <= 0) return;
    best.set(nKey, nc);
    parent.set(nKey, e);
    pq.push({ cost: nc, key: nKey });
  }

  buildPlan(parent, endKey, startSec, arriveSec) {
    const net = this.net;
    const chain = [];
    for (let k = endKey; ;) {
      const e = parent.get(k);
      if (e === undefined) break;
      chain.push(e);
      if (e.type === TYPE_START) break;
      k = e.fromKey;
    }
    chain.reverse();

    const plan = { startSec, boardSec: -1, arriveSec, rows: [] };
    let lastArrive = -1;
    for (const e of chain) {
      if (e.type === TYPE_TRANSFER) {
        plan.rows.push({ transfer: true, gid: e.fromGid, platformSec: e.arriveSec });
      } else if (e.type === TYPE_RIDE) {
        const last = plan.rows[plan.rows.length - 1];
        if (last && !last.transfer && last.corridorId === e.corridorId && last.dir === e.dir && lastArrive === e.departSec) {
          this.extendLeg(last, e);
        } else {
          const leg = this.newLeg(e);
          plan.rows.push(leg);
          if (plan.boardSec < 0) plan.boardSec = e.departSec;
        }
        const lastLeg = plan.rows[plan.rows.length - 1];
        lastArrive = lastLeg.stopArriveSec[lastLeg.stopArriveSec.length - 1];
      }
    }
    return plan;
  }

  /** 新建一段行程：从上车点到下车点，含中间各站及推算到达时刻 */
  newLeg(e) {
    const net = this.net;
    const c = net.corridors.get(e.corridorId);
    const bIdx = net.stopIndex(e.corridorId, e.fromGid), aIdx = net.stopIndex(e.corridorId, e.toGid);
    const step = net.stepOf(e.corridorId, e.dir);
    const stopGids = [c.stopGids[bIdx]], stopArriveSec = [];
    for (let i = bIdx + step; ; i += step) {
      stopGids.push(c.stopGids[i]);
      stopArriveSec.push(e.departSec + net.cumSec(e.corridorId, bIdx, i, this.runSec));
      if (i === aIdx) break;
    }
    return { transfer: false, corridorId: e.corridorId, dir: e.dir, boardSec: e.departSec, stopGids, stopArriveSec };
  }

  /** 延长一段行程至 e.toGid（同一班车继续乘坐），新到站以 e.departSec 为锚 */
  extendLeg(leg, e) {
    const net = this.net;
    const c = net.corridors.get(e.corridorId);
    const step = net.stepOf(e.corridorId, e.dir);
    const curIdx = net.stopIndex(e.corridorId, leg.stopGids[leg.stopGids.length - 1]);
    const aIdx = net.stopIndex(e.corridorId, e.toGid);
    for (let i = curIdx + step; ; i += step) {
      leg.stopGids.push(c.stopGids[i]);
      leg.stopArriveSec.push(e.departSec + net.cumSec(e.corridorId, curIdx, i, this.runSec));
      if (i === aIdx) break;
    }
  }
}

/** 方案统计：换乘次数、换乘候车余量合计、经由站数 */
export function planStats(plan, transferSec) {
  let transfers = 0, gap = 0, stops = 0, prevArrive = -1;
  for (const row of plan.rows) {
    if (row.transfer) { transfers++; continue; }
    stops += row.stopGids.length - 1;
    if (prevArrive >= 0) gap += (row.boardSec - prevArrive) - transferSec;
    prevArrive = row.stopArriveSec[row.stopArriveSec.length - 1];
  }
  return { transfers, gap, stops };
}

export function corridorName(c) {
  return c.menuLineIds.map((i) => `${i}号线`).join('/');
}

/** 秒 -> HH:MM[:SS]，跨日显示"次日+N" */
export function formatTime(sec) {
  const day = Math.floor(sec / 86400);
  const rem = ((sec % 86400) + 86400) % 86400;
  const hh = String(Math.floor(rem / 3600)).padStart(2, '0');
  const mm = String(Math.floor((rem % 3600) / 60)).padStart(2, '0');
  const t = `${hh}:${mm}` + (rem % 60 !== 0 ? `:${String(rem % 60).padStart(2, '0')}` : '');
  return day > 0 ? `次日+${day} ${t}` : t;
}
