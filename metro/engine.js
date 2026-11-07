// 苏州地铁路由引擎（Network.java / Router.java 的 JS 移植，浏览器与 Node 通用）。
// 数据由 tools/build-metro-data.mjs 从 timetable 项目的抓取缓存生成：
//   network.json = { corridors, stations, labels, officialLines, officialPairs }
//   tt_w{N}.json = { "走廊|站序": [方向0发车秒[], 方向1发车秒[]] }
// 载入时由逐站时刻表重建列车运行图（Network.buildRuns）：只有官网相邻站对时间可用
// （远距离站对是全网最短时间，含换乘），终点站与小交路终到站的到达时刻需推算。

export class Network {
  constructor() {
    this.corridors = new Map();          // cid -> {id, menuLineIds, stopGids, stopNames, d0Label, d1Label}
    this.gidOfName = new Map();
    this.nameOfGid = [];
    this.corridorsAtStation = new Map(); // gid -> [cid]（升序）
    this.pairMatrix = new Map();         // cid -> [i][j] = 官网站对秒数，-1 无数据（仅取相邻项）
    this.runs = new Map();               // "cid|dir" -> 列车运行图 [run]
    this.boardAt = new Map();            // "cid|dir|idx" -> [{dep, run, pos}]（升序）
    this.reachAt = new Map();            // "cid|dir|idx" -> 该方向上可达下游站数
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

    // 方向标签（往某站）取自时刻表；校验其必须是走廊端点，防止站序或标签错乱
    for (const [cid, c] of n.corridors) {
      const lab = (raw.labels ?? {})[cid];
      const l0 = lab ? lab.split('|').find((s) => s.startsWith('0:'))?.slice(2).trim() ?? null : null;
      const l1 = lab ? lab.split('|').find((s) => s.startsWith('1:'))?.slice(2).trim() ?? null : null;
      if (l0 != null && l0 !== c.stopNames[0] && l0 !== c.stopNames[c.stopNames.length - 1])
        throw new Error(`走廊 ${cid} 方向标签(${l0}/${l1})与车站端点(${c.stopNames[0]}/${c.stopNames[c.stopNames.length - 1]})不匹配`);
      c.d0Label = l0;
      c.d1Label = l1;
    }

    // 官网同线站对时间。官网站名用「/」分隔（如 苏州园区/火车站、陆慕/古巷），
    // 时刻表来源是连写，故统一去掉「/」再匹配
    const normName = (s) => s.replace(/\//g, '');
    const offPos = new Map(), offPair = new Map();
    for (const [lineName, idx, name] of raw.officialLines) {
      let pos = offPos.get(lineName);
      if (!pos) { offPos.set(lineName, (pos = new Map())); offPair.set(lineName, []); }
      pos.set(normName(name), idx);
      offPair.get(lineName)[idx] = normName(name);
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
      const pi = pos.get(normName(a)), pj = pos.get(normName(b));
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
            const pi = cl.offIdx.get(normName(names[i])), pj = cl.offIdx.get(normName(names[j]));
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
    n.buildRuns();
    return n;
  }

  /**
   * 由逐站时刻表重建列车运行图。
   * 站点页只列停靠时刻（大站快车跳过的站没有），终点站（含小交路终到站）不记到达时刻，
   * 因此：
   *   - 相邻站按「无越行」顺序配对，hop 取官网相邻时间（不准时才用相互关推算）；
   *   - 配对率过低（<80%）视为运营分界（如 6 号线南斜步：两段小交路不贯通），不跨段串联；
   *   - 未配上的车视为到前方最近站终到，到达时刻 = 末次发车 + hop。
   */
  buildRuns() {
    const TOL = 60;        // 时刻配对容差（秒）
    const MIN_RATE = 0.8;  // 配对率下限，低于此判为运营分界
    const match = (a, b, hop, tol = TOL) => {
      const pairs = [];
      let i = 0, j = 0;
      while (i < a.length && j < b.length) {
        const d = b[j] - a[i] - hop;
        if (Math.abs(d) <= tol) { pairs.push([i, j]); i++; j++; }
        else if (d < 0) j++;
        else i++;
      }
      return pairs;
    };
    const pickHop = (a, b, off) => {
      if (!a.length || !b.length) return off > 0 ? off : 120;
      let best = off > 0 ? off : 0, bestN = off > 0 ? match(a, b, off).length : -1;
      if (bestN >= a.length) return best;  // 已全配对上，无需再试
      for (let h = 60; h <= 600; h += 60) {
        const n = match(a, b, h).length;
        if (n > bestN) { bestN = n; best = h; if (n >= a.length) break; }
      }
      return best > 0 ? best : 120;
    };

    for (const [cid, c] of this.corridors) {
      const N = c.stopGids.length, mat = this.pairMatrix.get(cid);

      for (let dir = 0; dir <= 1; dir++) {
        const order = [];
        for (let p = 0; p < N; p++) order.push(dir === 0 ? p : N - 1 - p);
        const deps = order.map((i) => this.table(cid, i, dir));
        const hop = [];
        for (let p = 0; p < N - 1; p++) hop.push(pickHop(deps[p], deps[p + 1], mat[order[p]][order[p + 1]]));

        const next = new Map(), prev = new Map();
        const boundary = [];
        for (let p = 0; p < N - 1; p++) {
          const A = deps[p], B = deps[p + 1];
          if (!A.length || !B.length) { boundary.push(true); continue; }
          const pairs = match(A, B, hop[p]);
          const rate = Math.min(pairs.length / A.length, pairs.length / B.length);
          boundary.push(rate < MIN_RATE);
          if (rate < MIN_RATE) continue;
          for (const [i, j] of pairs) {
            next.set(`${p}|${i}`, `${p + 1}|${j}`);
            prev.set(`${p + 1}|${j}`, `${p}|${i}`);
          }
        }
        // 跳站补链：本站有车、下一站无，但下下站时刻吻合（大站快车）
        for (let p = 0; p + 2 < N; p++) {
          if (boundary[p] || boundary[p + 1]) continue;
          for (let i = 0; i < deps[p].length; i++) {
            if (next.has(`${p}|${i}`)) continue;
            const expect = deps[p][i] + hop[p] + hop[p + 1];
            for (let j = 0; j < deps[p + 2].length; j++) {
              if (prev.has(`${p + 2}|${j}`)) continue;
              if (Math.abs(deps[p + 2][j] - expect) <= TOL) {
                next.set(`${p}|${i}`, `${p + 2}|${j}`);
                prev.set(`${p + 2}|${j}`, `${p}|${i}`);
                break;
              }
            }
          }
        }

        const runs = [], seen = new Set();
        for (let p = 0; p < N; p++) {
          for (let i = 0; i < deps[p].length; i++) {
            const key = `${p}|${i}`;
            if (seen.has(key) || prev.has(key)) continue;
            const stops = [];
            let cur = key;
            while (cur) {
              seen.add(cur);
              const [pp, ii] = cur.split('|').map(Number);
              stops.push([order[pp], deps[pp][ii]]);
              cur = next.get(cur);
            }
            runs.push({ stops });
          }
        }
        // 终到时刻：末次发车 + 至下一站的 hop（终点站/小交路终到站均不记到达时刻）
        for (const run of runs) {
          const last = run.stops[run.stops.length - 1];
          const p = dir === 0 ? last[0] : N - 1 - last[0];
          if (p < N - 1) run.stops.push([order[p + 1], last[1] + hop[p]]);
        }

        this.runs.set(`${cid}|${dir}`, runs);
        for (const run of runs) {
          for (let k = 0; k < run.stops.length - 1; k++) {  // 末站是到达，不能上车
            const key = `${cid}|${dir}|${run.stops[k][0]}`;
            let list = this.boardAt.get(key);
            if (!list) this.boardAt.set(key, (list = []));
            list.push({ dep: run.stops[k][1], run, pos: k });
          }
        }
      }
    }
    for (const [key, list] of this.boardAt) {
      list.sort((a, b) => a.dep - b.dep);
      const seen = new Set();
      for (const { run, pos } of list) {
        for (let s = pos + 1; s < run.stops.length; s++) seen.add(run.stops[s][0]);
      }
      this.reachAt.set(key, seen.size);
    }
  }

  /** 某走廊某方向某站可上的列车（按发车时刻升序） */
  boardings(cid, dir, idx) {
    return this.boardAt.get(`${cid}|${dir}|${idx}`) ?? [];
  }

  /** 某站起该方向可达的下游站数（用于提前结束逐班展开） */
  reachCount(cid, dir, idx) {
    return this.reachAt.get(`${cid}|${dir}|${idx}`) ?? 0;
  }

  table(cid, idx, dir) {
    const t = this.tables.get(`${cid}|${idx}`);
    return t ? t[dir] : [];
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

/** 状态键：车站 << 7 | (走廊+2) | 是否刚换乘到站台（与 Java 版 Router.key 一致） */
const key = (gid, corridor, afterTransfer) => gid * 128 + (corridor + 2) + (afterTransfer ? 64 : 0);
const decodeKey = (k) => {
  const low = k & 127;
  return { gid: Math.floor(k / 128), corridor: (low & 63) - 2, afterTransfer: (low & 64) !== 0 };
};

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

/** 可上列车列表（按发车升序）中第一个 dep >= t 的下标；无则 -1 */
function firstAtOrAfter(list, t) {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].dep < t) lo = mid + 1; else hi = mid;
  }
  return lo < list.length ? lo : -1;
}

export class Router {
  constructor(net, transferSec) {
    this.net = net;
    this.transferSec = transferSec;
  }

  /** 给定最早出发时刻，返回最优方案；不可达返回 null（与 Java 版逐字一致） */
  routeDepart(fromGid, toGid, startSec) {
    const net = this.net;
    if (fromGid === toGid) return { startSec, boardSec: startSec, arriveSec: startSec, rows: [] };

    const bestCost = new Map(), parent = new Map();
    const pq = new Heap((a, b) => cmpCost(a.cost, b.cost));
    const startKey = key(fromGid, START, false);
    const startCost = { time: startSec, gap: 0, count: 0 };
    bestCost.set(startKey, startCost);
    pq.push({ cost: startCost, key: startKey });

    while (pq.size > 0) {
      const cur = pq.pop();
      if (bestCost.get(cur.key) !== cur.cost) continue;
      const c = cur.cost, k = cur.key;
      const { gid, corridor, afterTransfer } = decodeKey(k);

      if (corridor === START) {
        for (const l of net.corridorsAtStation.get(gid) ?? []) {
          this.relaxEdge(bestCost, parent, pq, key(gid, l, false), { time: c.time, gap: c.gap, count: c.count },
            { type: TYPE_START, fromGid: gid, fromCorridor: START, corridorId: l, dir: -1, toGid: gid, departSec: c.time, arriveSec: c.time }, k);
        }
        continue;
      }
      const idx = net.stopIndex(corridor, gid);
      const stops = net.corridors.get(corridor).stopGids;
      for (let dir = 0; dir <= 1; dir++) {
        const list = net.boardings(corridor, dir, idx);
        const b = firstAtOrAfter(list, c.time);
        if (b < 0) continue;
        const reachable = net.reachCount(corridor, dir, idx);
        const covered = new Set();
        // 按发车顺序逐班展开；某站首次出现即为最早到达（无越行），此后各班的同一站不再松弛
        for (let bi = b; bi < list.length && covered.size < reachable; bi++) {
          const { run, pos, dep } = list[bi];
          const gapAdd = afterTransfer ? dep - c.time : 0;
          for (let s = pos + 1; s < run.stops.length; s++) {
            const nidx = run.stops[s][0];
            if (covered.has(nidx)) continue;
            covered.add(nidx);
            const arrive = run.stops[s][1];
            this.relaxEdge(bestCost, parent, pq, key(stops[nidx], corridor, false), { time: arrive, gap: c.gap + gapAdd, count: c.count },
              { type: TYPE_RIDE, fromGid: gid, fromCorridor: corridor, corridorId: corridor, dir, toGid: stops[nidx], run, fromPos: pos, toPos: s, departSec: dep, arriveSec: arrive }, k);
          }
        }
      }
      for (const m of net.corridorsAtStation.get(gid) ?? []) {
        if (m === corridor) continue;
        this.relaxEdge(bestCost, parent, pq, key(gid, m, true), { time: c.time + this.transferSec, gap: c.gap, count: c.count + 1 },
          { type: TYPE_TRANSFER, fromGid: gid, fromCorridor: corridor, corridorId: m, dir: -1, toGid: gid, departSec: c.time, arriveSec: c.time + this.transferSec }, k);
      }
    }

    let bestKey = -1, bestC = null;
    for (const [kk, cc] of bestCost) {
      if (decodeKey(kk).gid !== toGid) continue;
      if (bestC === null || cmpCost(cc, bestC) < 0) { bestC = cc; bestKey = kk; }
    }
    if (bestKey < 0) return null;

    const chain = [];
    for (let k = bestKey; ;) {
      const e = parent.get(k);
      if (e === undefined) break;
      chain.push(e);
      if (e.type === TYPE_START) break;
      k = e.from;
    }
    chain.reverse();
    return this.buildPlan(chain, startSec, bestC.time);
  }

  relaxEdge(best, parent, pq, k, cost, edge, fromKey) {
    const old = best.get(k);
    if (old !== undefined && cmpCost(old, cost) <= 0) return;
    best.set(k, cost);
    parent.set(k, { ...edge, from: fromKey });
    pq.push({ cost, key: k });
  }

  /**
   * 给定最早出发时刻，返回全部并列最快（到达时刻同为最早）的方案。
   * 状态与 Java 版 Router 完全一致：车站 × 所在走廊 × 是否刚换乘到站台。
   * 阶段一按 (时间, 换乘候车余量, 换乘次数) 字典序求各状态最优代价；
   * 阶段二只在「沿紧边前进不推迟到达」的子图上枚举全部最短路径，
   * 因此换乘点不同、或换乘次数不同但到达时刻相同的方案都会列出。
   */
  routeDepartAll(fromGid, toGid, startSec) {
    const net = this.net;
    if (fromGid === toGid) return [{ startSec, boardSec: startSec, arriveSec: startSec, rows: [] }];

    const startKey = key(fromGid, START, false);
    const bestCost = new Map([[startKey, { time: startSec, gap: 0, count: 0 }]]);
    const pq = new Heap((a, b) => cmpCost(a.cost, b.cost));
    pq.push({ cost: bestCost.get(startKey), key: startKey });

    while (pq.size > 0) {
      const cur = pq.pop();
      if (bestCost.get(cur.key) !== cur.cost) continue;
      const { gid, corridor, afterTransfer } = decodeKey(cur.key);
      const c = cur.cost;
      const idx = corridor === START ? -1 : net.stopIndex(corridor, gid);

      if (corridor === START) {
        for (const l of net.corridorsAtStation.get(gid) ?? []) {
          this.relaxCost(bestCost, pq, key(gid, l, false), { time: c.time, gap: c.gap, count: c.count });
        }
        continue;
      }
      const stops = net.corridors.get(corridor).stopGids;
      for (let dir = 0; dir <= 1; dir++) {
        const list = net.boardings(corridor, dir, idx);
        const b = firstAtOrAfter(list, c.time);
        if (b < 0) continue;
        const reachable = net.reachCount(corridor, dir, idx);
        const covered = new Set();
        for (let bi = b; bi < list.length && covered.size < reachable; bi++) {
          const { run, pos, dep } = list[bi];
          const gapAdd = afterTransfer ? dep - c.time : 0;
          for (let s = pos + 1; s < run.stops.length; s++) {
            const nidx = run.stops[s][0];
            if (covered.has(nidx)) continue;
            covered.add(nidx);
            this.relaxCost(bestCost, pq, key(stops[nidx], corridor, false), {
              time: run.stops[s][1], gap: c.gap + gapAdd, count: c.count,
            });
          }
        }
      }
      for (const m of net.corridorsAtStation.get(gid) ?? []) {
        if (m === corridor) continue;
        this.relaxCost(bestCost, pq, key(gid, m, true), { time: c.time + this.transferSec, gap: c.gap, count: c.count + 1 });
      }
    }

    let minArrive = Infinity;
    for (const [k, c] of bestCost) if (decodeKey(k).gid === toGid && c.time < minArrive) minArrive = c.time;
    if (minArrive === Infinity) return [];

    const out = [];
    this.enumerate(fromGid, toGid, startSec, minArrive, bestCost, out);
    out.sort((a, b) => cmpCost(a.cost, b.cost));
    return dedupePlans(out.map((x) => this.buildPlan(x.path, startSec, minArrive, true)));
  }

  relaxCost(best, pq, k, cost) {
    const old = best.get(k);
    if (old !== undefined && cmpCost(old, cost) <= 0) return;
    best.set(k, cost);
    pq.push({ cost, key: k });
  }

  /**
   * DFS 枚举：只在「沿紧边走到下一状态仍等于其最优代价」时前进。
   * 同一线路同一方向上「下车后立刻又上同一班车」与「一次坐到底」等价，
   * 这类拆分会让枚举量爆炸并产生重复方案，因此在续乘时不重复上同一班车。
   */
  enumerate(fromGid, toGid, startSec, minArrive, bestCost, out) {
    const net = this.net;
    const seen = new Set();
    const eq = (k, cost) => {
      const b = bestCost.get(k);
      return b !== undefined && cmpCost(b, cost) === 0;
    };

    const walk = (gid, corridor, afterTransfer, cost, path) => {
      if (gid === toGid && cost.time === minArrive) {
        out.push({ path: [...path], cost: { ...cost } });
        return;
      }
      if (cost.time > minArrive) return;
      // 同一 (状态, 代价, 步数) 只展开一次：折返列车会形成零耗时环
      const sig = `${gid}/${corridor}/${afterTransfer}/${cost.time}/${cost.gap}/${cost.count}/${path.length}`;
      if (seen.has(sig)) return;
      seen.add(sig);

      if (corridor === START) {
        for (const l of net.corridorsAtStation.get(gid) ?? []) {
          const nc = { time: cost.time, gap: cost.gap, count: cost.count };
          if (!eq(key(gid, l, false), nc)) continue;
          path.push({ type: TYPE_START, fromGid: gid, corridorId: l, dir: -1, toGid: gid, departSec: cost.time, arriveSec: cost.time });
          walk(gid, l, false, nc, path);
          path.pop();
        }
        return;
      }

      const idx = net.stopIndex(corridor, gid);
      const stops = net.corridors.get(corridor).stopGids;
      for (let dir = 0; dir <= 1; dir++) {
        const list = net.boardings(corridor, dir, idx);
        const b = firstAtOrAfter(list, cost.time);
        if (b < 0) continue;
        const reachable = net.reachCount(corridor, dir, idx);
        const covered = new Set();
        for (let bi = b; bi < list.length && covered.size < reachable; bi++) {
          const { run, pos, dep } = list[bi];
          const gapAdd = afterTransfer ? dep - cost.time : 0;
          for (let s = pos + 1; s < run.stops.length; s++) {
            const nidx = run.stops[s][0];
            if (covered.has(nidx)) continue;
            covered.add(nidx);
            const arrive = run.stops[s][1];
            const nc = { time: arrive, gap: cost.gap + gapAdd, count: cost.count };
            if (!eq(key(stops[nidx], corridor, false), nc)) continue;
            path.push({ type: TYPE_RIDE, fromGid: gid, corridorId: corridor, dir, toGid: stops[nidx], run, fromPos: pos, toPos: s, departSec: dep, arriveSec: arrive });
            walk(stops[nidx], corridor, false, nc, path);
            path.pop();
          }
        }
      }
      for (const m of net.corridorsAtStation.get(gid) ?? []) {
        if (m === corridor) continue;
        const nc = { time: cost.time + this.transferSec, gap: cost.gap, count: cost.count + 1 };
        if (!eq(key(gid, m, true), nc)) continue;
        path.push({ type: TYPE_TRANSFER, fromGid: gid, corridorId: m, dir: -1, toGid: gid, departSec: cost.time, arriveSec: nc.time });
        walk(gid, m, true, nc, path);
        path.pop();
      }
    };

    walk(fromGid, START, false, { time: startSec, gap: 0, count: 0 }, []);
  }

  /** 给定到达时限，返回"最晚出发仍不迟到"的方案；无法按时到达返回 null（与 Java 版一致） */
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

  /** 给定到达时限，返回最晚出发仍不迟到的全部并列方案（并列 = 出发时刻相同） */
  routeArriveAll(fromGid, toGid, deadlineSec) {
    const net = this.net;
    const cands = new Set();
    for (const c of net.corridorsAtStation.get(fromGid) ?? []) {
      const idx = net.stopIndex(c, fromGid);
      for (let dir = 0; dir <= 1; dir++) for (const sec of net.table(c, idx, dir)) cands.add(sec);
    }
    if (cands.size === 0) return [];
    const cs = [...cands].sort((a, b) => a - b);

    // 二分出仍能按时到达的最晚出发时刻（到达时刻随出发时刻单调不减）
    let lo = 0, hi = cs.length - 1, latest = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const plan = this.routeDepart(fromGid, toGid, cs[mid]);
      if (plan !== null && plan.arriveSec <= deadlineSec) { latest = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (latest < 0) return [];

    // 取该出发时刻下全部并列最快方案，再去重与筛选
    const plans = dedupePlans(this.routeDepartAll(fromGid, toGid, cs[latest]).filter((p) => p.arriveSec <= deadlineSec));
    let latestBoard = -1;
    for (const p of plans) if (p.boardSec > latestBoard) latestBoard = p.boardSec;
    return plans.filter((p) => p.boardSec === latestBoard);
  }

  /**
   * 把路径还原成方案。
   * mergeSameLine 为真时把同一列车的连续乘车并成一段（仅多方案枚举用；
   * 单方案路径保持与 Java 版一致，以便逐字对拍）。
   */
  buildPlan(chain, startSec, arriveSec, mergeSameLine = false) {
    const plan = { startSec, boardSec: -1, arriveSec, rows: [] };
    for (const e of chain) {
      if (e.type === TYPE_TRANSFER) {
        plan.rows.push({ transfer: true, gid: e.fromGid, platformSec: e.arriveSec });
      } else if (e.type === TYPE_RIDE) {
        const last = plan.rows[plan.rows.length - 1];
        // 同一列车继续乘坐（枚举会把一段车拆成多步）
        if (last && last.run === e.run && last.toPos === e.fromPos && (mergeSameLine || last.boardSec === e.run.stops[e.fromPos][1])) {
          this.extendLeg(last, e);
        } else {
          plan.rows.push(this.newLeg(e));
          if (plan.boardSec < 0) plan.boardSec = e.departSec;
        }
      }
    }
    return plan;
  }

  /** 新建一段行程：取该班车实际停靠的站序与时刻 */
  newLeg(e) {
    const net = this.net;
    const stopGids = [], stopArriveSec = [];
    for (let s = e.fromPos; s <= e.toPos; s++) stopGids.push(net.corridors.get(e.corridorId).stopGids[e.run.stops[s][0]]);
    for (let s = e.fromPos + 1; s <= e.toPos; s++) stopArriveSec.push(e.run.stops[s][1]);
    return { transfer: false, corridorId: e.corridorId, dir: e.dir, run: e.run, toPos: e.toPos, boardSec: e.departSec, stopGids, stopArriveSec };
  }

  /** 延长一段行程至 e.toPos */
  extendLeg(leg, e) {
    const c = this.net.corridors.get(e.corridorId);
    for (let s = e.fromPos + 1; s <= e.toPos; s++) {
      leg.stopGids.push(c.stopGids[e.run.stops[s][0]]);
      leg.stopArriveSec.push(e.run.stops[s][1]);
    }
    leg.toPos = e.toPos;
  }
}

/** 方案签名：按「换乘点 + 各乘车段的线路/方向/上下车站」判定，乘车中途换车不构成不同方案 */
function planSignature(plan) {
  return plan.rows.map((r) => (r.transfer
    ? `T${r.gid}`
    : `R${r.corridorId}/${r.dir}/${r.stopGids[0]}/${r.stopGids[r.stopGids.length - 1]}`)).join('|');
}

/** 按换乘次数与候车余量以外的顺序去重，保留先出现的（调用方已按字典序排好） */
function dedupePlans(plans) {
  const seen = new Set(), out = [];
  for (const p of plans) {
    const sig = planSignature(p);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(p);
  }
  return out;
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
