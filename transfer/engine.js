// 路路通中转换乘引擎（LulutongTransfer.java 的 JS 移植，浏览器与 Node 通用）。
// 数据文件与 Java 版完全一致：s.i / t.i 索引（Java readUTF）、T0..T19.dat 车次记录、
// t.rule 开行规则；可选 sl.json / osm_stations.tsv 车站坐标（用于邻站接驳）。
//
// 与 Java 的差异仅在表示层：乘车边用定长类型数组（CSR）存放，避免 76 万个小对象。

const MAX_SEARCH_DAYS = 20;

/** Java DataInputStream.readUTF：u2 长度 + modified UTF-8 */
function readModifiedUtf8(b, start, len) {
  let s = '', i = start;
  const end = start + len;
  while (i < end) {
    const c = b[i];
    if (c < 0x80) { s += String.fromCharCode(c); i += 1; }
    else if ((c & 0xe0) === 0xc0) { s += String.fromCharCode(((c & 0x1f) << 6) | (b[i + 1] & 0x3f)); i += 2; }
    else { s += String.fromCharCode(((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f)); i += 3; }
  }
  return s;
}

function readIndex(b) {
  const count = (b[0] << 8) | b[1];
  const out = new Array(count);
  let p = 2;
  for (let i = 0; i < count; i++) {
    const len = (b[p] << 8) | b[p + 1];
    p += 2;
    out[i] = readModifiedUtf8(b, p, len);
    p += len;
  }
  return out;
}

const u = (b, p) => b[p];
const read255 = (b, p) => b[p] * 255 + b[p + 1];
const decodeDate = (b, p) => b[p] + b[p + 1] * 128 + b[p + 2] * 16384 + b[p + 3] * 2097152;

/** yyyymmdd -> epoch day（与 LocalDate.parse(yyyymmdd, BASIC_ISO_DATE).toEpochDay() 一致） */
function parseDateDay(v) {
  const s = String(v).padStart(8, '0');
  return Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) / 86400000);
}

const dayToDate = (day) => new Date(day * 86400000);

/** 遍历 T*.dat 中的车次记录（与 Java loadTrains 的解析顺序一致） */
function* eachTrainRecord(bytes) {
  let p = 0;
  while (p + 17 <= bytes.length) {
    const trainId = read255(bytes, p);
    const count = read255(bytes, p + 15);
    const len = 17 + count * 7;
    if (count < 2 || len <= 0 || p + len > bytes.length) break;
    const q = p + 2;
    yield {
      trainId,
      type: u(bytes, q),
      startDate: decodeDate(bytes, q + 3),
      endDate: decodeDate(bytes, q + 7),
      ruleIndex: read255(bytes, q + 11),
      count,
      stopsOffset: q + 15,
      next: p + len,
    };
    p += len;
  }
}

/**
 * 解析某车次的停站表；任一停站非法返回 null（与 Java parseStops 一致）。
 * 返回 {station, arrOffset, depOffset} 三个等长数组。
 */
function parseStops(bytes, p, count, stationCount) {
  const station = new Int32Array(count), arrOffset = new Int32Array(count), depOffset = new Int32Array(count);
  let previousDeparture = -Infinity;
  for (let i = 0; i < count; i++) {
    const st = read255(bytes, p);
    if (st < 0 || st >= stationCount) return null;
    const hour = u(bytes, p + 2), minute = u(bytes, p + 3), dwell = u(bytes, p + 4);
    if (hour > 30 || minute >= 60) return null;
    let arr = hour * 60 + minute;
    if (previousDeparture !== -Infinity) while (arr < previousDeparture) arr += 1440;
    const dep = arr + dwell;
    station[i] = st;
    arrOffset[i] = arr;
    depOffset[i] = dep;
    previousDeparture = dep;
    p += 7;
  }
  return { station, arrOffset, depOffset };
}

export class TransferEngine {
  constructor(stationNames, trainNames, trains, rules, rides, ver) {
    this.stationNames = stationNames;
    this.trainNames = trainNames;
    this.trains = trains;
    this.rules = rules;
    this.rides = rides;      // {trainId,from,to,depOffset,arrOffset, outIdx,outRide,inIdx,inRide}
    this.ver = ver;
    this.walkAdj = null;
    this.walkKey = '';
    this.walkSource = '';
    this.coords = new Map();
  }

  /** readBytes: async (文件名) => Uint8Array|null；readText 可选，缺省由字节解码 */
  static async load(readBytes, readText = null) {
    const text = async (name) => {
      try {
        if (readText) return await readText(name);
        const b = await readBytes(name);
        return b ? new TextDecoder().decode(b) : null;
      } catch { return null; }
    };
    // 索引与 20 个车次分片一次并行取回（串行下载会让首屏多等十几秒）
    const [stationBytes, trainBytes, rulesText, verText, ...shards] = await Promise.all([
      readBytes('s.i'), readBytes('t.i'), text('t.rule'), text('ver.txt'),
      ...Array.from({ length: 20 }, (_, i) => readBytes(`T${i}.dat`)),
    ]);
    for (const [name, bytes] of [['s.i', stationBytes], ['t.i', trainBytes],
      ...shards.map((b, i) => [`T${i}.dat`, b])]) {
      if (!bytes) throw new Error(`缺少数据文件: ${name}`);
    }

    const stationNames = readIndex(stationBytes);
    const trainNames = readIndex(trainBytes);

    const rules = [];
    if (rulesText != null) {
      for (const line of rulesText.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) rules.push({ period: Number(parts[0]), mask: Number(parts[1]) });
      }
    }

    const trains = new Array(trainNames.length).fill(null);
    // 第一遍：统计各站乘车边数量
    const outCount = new Int32Array(stationNames.length);
    const inCount = new Int32Array(stationNames.length);
    let total = 0;
    for (const bytes of shards) {
      for (const rec of eachTrainRecord(bytes)) {
        if (rec.trainId >= trainNames.length) continue;
        const stops = parseStops(bytes, rec.stopsOffset, rec.count, stationNames.length);
        if (stops === null) continue;
        for (let i = 0; i < rec.count - 1; i++) {
          for (let j = i + 1; j < rec.count; j++) {
            if (stops.arrOffset[j] < stops.depOffset[i]) continue;
            outCount[stops.station[i]]++;
            inCount[stops.station[j]]++;
            total++;
          }
        }
      }
    }

    const outStart = new Int32Array(stationNames.length + 1);
    const inStart = new Int32Array(stationNames.length + 1);
    for (let i = 0; i < stationNames.length; i++) {
      outStart[i + 1] = outStart[i] + outCount[i];
      inStart[i + 1] = inStart[i] + inCount[i];
    }

    const rideTrain = new Int32Array(total), rideFrom = new Int32Array(total), rideTo = new Int32Array(total);
    const rideDep = new Int32Array(total), rideArr = new Int32Array(total);
    const outRide = new Int32Array(total), inRide = new Int32Array(total);
    const outPos = outStart.slice(0, stationNames.length), inPos = inStart.slice(0, stationNames.length);

    // 第二遍：按 Java addRides 的顺序填充
    let r = 0;
    for (const bytes of shards) {
      for (const rec of eachTrainRecord(bytes)) {
        if (rec.trainId >= trainNames.length) continue;
        const stops = parseStops(bytes, rec.stopsOffset, rec.count, stationNames.length);
        if (stops === null) continue;
        const startDay = parseDateDay(rec.startDate), endDay = parseDateDay(rec.endDate);
        trains[rec.trainId] = { id: rec.trainId, type: rec.type, startDay, endDay, ruleIndex: rec.ruleIndex };
        for (let i = 0; i < rec.count - 1; i++) {
          for (let j = i + 1; j < rec.count; j++) {
            if (stops.arrOffset[j] < stops.depOffset[i]) continue;
            rideTrain[r] = rec.trainId;
            rideFrom[r] = stops.station[i];
            rideTo[r] = stops.station[j];
            rideDep[r] = stops.depOffset[i];
            rideArr[r] = stops.arrOffset[j];
            outRide[outPos[stops.station[i]]++] = r;
            inRide[inPos[stops.station[j]]++] = r;
            r++;
          }
        }
      }
    }

    const ver = (verText ?? '').replace(/^\uFEFF/, '').trim();

    const engine = new TransferEngine(stationNames, trainNames, trains, rules,
      { total, trainId: rideTrain, from: rideFrom, to: rideTo, depOffset: rideDep, arrOffset: rideArr, outStart, outRide, inStart, inRide }, ver);
    engine.stationLookup = new Map();
    for (let i = 0; i < stationNames.length; i++) {
      for (const part of stationNames[i].split('/')) {
        const k = part.toUpperCase();
        if (part !== '' && !engine.stationLookup.has(k)) engine.stationLookup.set(k, i);
      }
    }
    return engine;
  }

  statusLine() {
    return `已加载路路通数据 ${this.ver}: 车站 ${this.stationNames.length}, 车次 ${this.trainNames.length}, 乘车边 ${this.rides.total}`;
  }

  stationName(index) {
    if (index < 0 || index >= this.stationNames.length) return '';
    const name = this.stationNames[index];
    const slash = name.indexOf('/');
    return slash >= 0 ? name.slice(0, slash) : name;
  }

  trainName(index) {
    if (index < 0 || index >= this.trainNames.length) return '';
    return this.trainNames[index];
  }

  /** GUI 下拉框用的站名列表（去重、保持数据顺序） */
  allStations() {
    const seen = new Set(), out = [];
    for (let i = 0; i < this.stationNames.length; i++) {
      const n = this.stationName(i);
      if (n !== '' && !seen.has(n)) { seen.add(n); out.push(n); }
    }
    return out;
  }

  /** 装载车站坐标；jsonText/tsvText 缺省表示不可用。key 用于避免重复计算 */
  configureWalk(enabled, speedKmh, maxWalkKm, jsonText, tsvText, key) {
    this.speedKmh = speedKmh > 0 ? speedKmh : 20;
    this.maxWalkKm = maxWalkKm > 0 ? maxWalkKm : 30;
    const k = `${enabled}|${this.speedKmh}|${this.maxWalkKm}|${key}`;
    if (this.walkKey === k) return this.walkLog;
    this.walkKey = k;
    if (!enabled) {
      this.walkAdj = null;
      return (this.walkLog = '邻近车站换乘已停用');
    }
    return (this.walkLog = this.buildWalk(jsonText, tsvText));
  }

  /** 解析坐标并构建邻近站图，返回日志文本（与 Java loadNearbyStations 一致） */
  buildWalk(jsonText, tsvText) {
    const coords = new Map();
    if (jsonText) {
      const re = /"([^"]+)"\s*:\s*\{\s*"lat"\s*:\s*(-?[0-9.eE+]+)\s*,\s*"lon"\s*:\s*(-?[0-9.eE+]+)/g;
      for (const m of jsonText.matchAll(re)) if (!coords.has(m[1])) coords.set(m[1], [+m[2], +m[3]]);
    }
    if (tsvText) {
      for (const line of tsvText.split(/\r?\n/)) {
        if (line === '' || line.startsWith('@type')) continue;
        const c = splitTsv(line);
        if (c.length < 12) continue;
        const kind = c[11];
        if (kind === 'subway' || kind === 'light_rail' || kind === 'monorail') continue;
        const lat = Number(c[2]), lon = Number(c[3]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        for (let i = 4; i <= 9; i++) {
          if (c[i] === '') continue;
          for (const raw of c[i].split(/[;；]/)) {
            const v = raw.trim();
            if (v !== '' && !coords.has(v)) coords.set(v, [lat, lon]);
          }
        }
      }
    }
    this.coords = coords;
    if (coords.size === 0) {
      this.walkAdj = null;
      return '未找到车站坐标文件 (sl.json / osm_stations.tsv), 邻近车站换乘功能停用';
    }
    const n = this.stationNames.length;
    const idxs = [], latlon = [];
    for (let i = 0; i < n; i++) {
      const c = coords.get(this.stationNames[i].split('/')[0]);
      if (c) { idxs.push(i); latlon.push(c); }
    }
    const adj = new Array(n).fill(null);
    let pairs = 0;
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const km = haversineKm(latlon[a][0], latlon[a][1], latlon[b][0], latlon[b][1]);
        if (km > this.maxWalkKm) continue;
        const minutes = Math.max(1, Math.round((km / this.speedKmh) * 60));
        (adj[idxs[a]] ??= []).push({ to: idxs[b], minutes, km });
        (adj[idxs[b]] ??= []).push({ to: idxs[a], minutes, km });
        pairs++;
      }
    }
    this.walkAdj = adj;
    const src = (jsonText ? 'CRTransfer' : '') + (tsvText ? (jsonText ? '+OSM' : 'OSM') : '');
    return `车站坐标匹配 ${idxs.length}/${n} 站 (数据源: ${src}), 邻近站对 ${pairs} 个 (距离<=${trimNum(this.maxWalkKm)}km, 速度 ${trimNum(this.speedKmh)}km/h)`;
  }

  walkEdgeTo(from, to) {
    if (this.walkAdj === null || from < 0 || from >= this.walkAdj.length || this.walkAdj[from] === null) return null;
    for (const e of this.walkAdj[from]) if (e.to === to) return e;
    return null;
  }

  /** from/to 为站名；time 为 yyyyMMddhhmm */
  search(from, to, time, departMode, minTransfer) {
    const f = this.stationLookup.get(String(from).toUpperCase());
    const t = this.stationLookup.get(String(to).toUpperCase());
    if (f === undefined) throw new Error(`找不到出发站: ${from}`);
    if (t === undefined) throw new Error(`找不到到达站: ${to}`);
    if (!/^\d{12}$/.test(time ?? '')) throw new Error('时间格式应为 YYYYMMDDhhmm');
    if (minTransfer < 0) throw new Error('换乘时间不能为负数');

    const inputMinute = toAbsMinute(time);
    let first, second;
    if (departMode) {
      first = this.searchForward(f, t, inputMinute, minTransfer, Number.MAX_SAFE_INTEGER);
      if (first === null) return null;
      second = this.searchBackward(f, t, first.arrivalTime(), minTransfer, inputMinute);
    } else {
      first = this.searchBackward(f, t, inputMinute, minTransfer, Number.MIN_SAFE_INTEGER);
      if (first === null) return null;
      second = this.searchForward(f, t, first.departureTime(), minTransfer, inputMinute);
    }
    return second !== null ? second : first;
  }

  searchForward(from, to, start, minTransfer, hardCeiling) {
    const deadline = Math.min(start + MAX_SEARCH_DAYS * 1440, hardCeiling);
    const labels = new Array(this.stationNames.length).fill(null);
    const pq = new Heap((a, b) => a.time - b.time || a.legs - b.legs || b.wait - a.wait);
    const initial = new State(from, start, 0, 0, null, null, -1, 0, 0);
    labels[from] = [initial];
    pq.push(initial);

    let best = null;
    while (pq.size > 0) {
      const cur = pq.pop();
      if (!cur.live) continue;
      if (best !== null && cur.time > best.arrivalTime()) break;
      const cand = this.completeForward(cur, to, minTransfer);
      if (cand !== null && betterResult(cand, best, true)) best = cand;
      if (best !== null && cur.time >= best.arrivalTime()) continue;
      const pruneAfter = best === null ? deadline : Math.min(deadline, best.arrivalTime());

      for (let k = this.rides.outStart[cur.station]; k < this.rides.outStart[cur.station + 1]; k++) {
        const ri = this.rides.outRide[k];
        const occ = this.nextOccurrence(ri, cur.boardFrom, pruneAfter);
        if (occ === null) continue;
        const wait = cur.wait + (cur.legs === 0 ? 0 : occ.dep - cur.time);
        const next = new State(this.rides.to[ri], occ.arr, cur.legs + 1, wait, cur, null, ri, occ.dep, occ.arr,
          cur.walkTotal, cur.walkCount, false, occ.arr + minTransfer);
        if (addLabel(labels, next, dominatesForward)) pq.push(next);
      }

      if (!cur.lastWalk && this.walkAdj !== null && this.walkAdj[cur.station] !== null) {
        for (const e of this.walkAdj[cur.station]) {
          const walkMin = e.minutes + 2 * minTransfer;
          const arriveNb = cur.time + walkMin;
          if (arriveNb > pruneAfter) continue;
          const boardFrom = cur.legs === 0 ? arriveNb : cur.time + Math.max(walkMin, minTransfer);
          const next = new State(e.to, arriveNb, cur.legs, cur.wait, cur, null, -1, 0, 0,
            cur.walkTotal + walkMin, cur.walkCount + 1, true, boardFrom,
            { walk: true, from: cur.station, to: e.to, dep: cur.time, arr: arriveNb, km: e.km }, null);
          if (addLabel(labels, next, dominatesForward)) pq.push(next);
        }
      }
    }
    return best;
  }

  completeForward(cur, to, minTransfer) {
    if (cur.legs === 0) return null;
    if (cur.station === to) return this.makeResult(cur, true);
    if (cur.lastWalk) return null;
    const e = this.walkEdgeTo(cur.station, to);
    if (e === null) return null;
    const base = this.makeResult(cur, true);
    const walkMin = e.minutes + 2 * minTransfer;
    base.legs.push({ walk: true, from: cur.station, to, dep: cur.time, arr: cur.time + walkMin, km: e.km });
    return base;
  }

  searchBackward(from, to, deadline, minTransfer, hardFloor) {
    const floor = Math.max(deadline - MAX_SEARCH_DAYS * 1440, hardFloor);
    const labels = new Array(this.stationNames.length).fill(null);
    const pq = new Heap((a, b) => b.time - a.time || a.legs - b.legs || b.wait - a.wait);
    const initial = new State(to, deadline, 0, 0, null, null, -1, 0, 0);
    labels[to] = [initial];
    pq.push(initial);

    let best = null;
    while (pq.size > 0) {
      const cur = pq.pop();
      if (!cur.live) continue;
      if (best !== null && cur.time < best.departureTime()) break;
      const cand = this.completeBackward(cur, from, floor, minTransfer);
      if (cand !== null && betterResult(cand, best, false)) best = cand;
      if (best !== null && cur.time <= best.departureTime()) continue;
      const pruneBefore = best === null ? floor : Math.max(floor, best.departureTime());

      for (let k = this.rides.inStart[cur.station]; k < this.rides.inStart[cur.station + 1]; k++) {
        const ri = this.rides.inRide[k];
        const occ = this.previousOccurrence(ri, cur.boardFrom, pruneBefore);
        if (occ === null) continue;
        const wait = cur.wait + (cur.legs === 0 ? 0 : cur.time - occ.arr);
        const prev = new State(this.rides.from[ri], occ.dep, cur.legs + 1, wait, null, cur, ri, occ.dep, occ.arr,
          cur.walkTotal, cur.walkCount, false, occ.dep - minTransfer);
        if (addLabel(labels, prev, dominatesBackward)) pq.push(prev);
      }

      if (!cur.lastWalk && this.walkAdj !== null && this.walkAdj[cur.station] !== null) {
        for (const e of this.walkAdj[cur.station]) {
          const x = e.to;
          const walkMin = e.minutes + 2 * minTransfer;
          const latestArrival = cur.time - walkMin;
          if (latestArrival < floor) continue;
          for (let k = this.rides.inStart[x]; k < this.rides.inStart[x + 1]; k++) {
            const ri = this.rides.inRide[k];
            const occ = this.previousOccurrence(ri, latestArrival, pruneBefore);
            if (occ === null) continue;
            const wait = cur.wait + (cur.legs === 0 ? 0 : Math.max(0, cur.time - occ.arr - walkMin));
            const prev = new State(this.rides.from[ri], occ.dep, cur.legs + 1, wait, null, cur, ri, occ.dep, occ.arr,
              cur.walkTotal + walkMin, cur.walkCount + 1, true, occ.dep - minTransfer, null,
              { walk: true, from: this.rides.to[ri], to: cur.station, dep: occ.arr, arr: occ.arr + walkMin, km: e.km });
            if (addLabel(labels, prev, dominatesBackward)) pq.push(prev);
          }
        }
      }
    }
    return best;
  }

  completeBackward(cur, from, floor, minTransfer) {
    if (cur.legs === 0) return null;
    if (cur.station === from) return this.makeResult(cur, false);
    if (cur.lastWalk) return null;
    const e = this.walkEdgeTo(cur.station, from);
    if (e === null) return null;
    const walkMin = e.minutes + 2 * minTransfer;
    const dep = cur.time - walkMin;
    if (dep < floor) return null;
    const base = this.makeResult(cur, false);
    base.legs.unshift({ walk: true, from, to: cur.station, dep, arr: cur.time, km: e.km });
    return base;
  }

  /** 回溯状态链生成方案（Java SearchResult.forward/backward + mergeAdjacentSameTrain） */
  makeResult(end, forward) {
    const collected = [];
    for (let cur = end; cur !== null; cur = forward ? cur.prev : cur.next) {
      if (forward) {
        if (cur.walkInLeg !== null && cur.prev !== null) collected.push(cur.walkInLeg);
        if (cur.ride >= 0) collected.push(this.rideLeg(cur, false));
      } else {
        if (cur.ride >= 0) {
          collected.push(this.rideLeg(cur, true));
          if (cur.walkOutLeg !== null) collected.push(cur.walkOutLeg);
        }
      }
    }
    const legs = forward ? collected.reverse() : collected;
    return new SearchResult(this.mergeAdjacentSameTrain(legs));
  }

  rideLeg(cur, usePrev) {
    const ri = cur.ride;
    return {
      walk: false, ride: ri,
      from: this.rides.from[ri], to: this.rides.to[ri],
      dep: cur.rideDep, arr: cur.rideArr,
    };
  }

  mergeAdjacentSameTrain(legs) {
    if (legs.length < 2) return legs;
    const merged = [];
    let current = legs[0];
    for (let i = 1; i < legs.length; i++) {
      const next = legs[i];
      if (!current.walk && !next.walk && current.ride >= 0 && next.ride >= 0
        && this.rides.trainId[current.ride] === this.rides.trainId[next.ride] && current.to === next.from) {
        current = { walk: false, ride: current.ride, from: current.from, to: next.to, dep: current.dep, arr: next.arr };
      } else {
        merged.push(current);
        current = next;
      }
    }
    merged.push(current);
    return merged;
  }

  nextOccurrence(rideIndex, ready, deadline) {
    const train = this.trains[this.rides.trainId[rideIndex]];
    if (train === null) return null;
    let day = Math.ceil((ready - this.rides.depOffset[rideIndex]) / 1440);
    if (day < train.startDay) day = train.startDay;
    while (day <= train.endDay) {
      const dep = day * 1440 + this.rides.depOffset[rideIndex];
      const arr = day * 1440 + this.rides.arrOffset[rideIndex];
      if (dep > deadline || arr > deadline) return null;
      if (dep >= ready && this.activeOn(train, day)) return { dep, arr };
      day++;
    }
    return null;
  }

  previousOccurrence(rideIndex, ready, floor) {
    const train = this.trains[this.rides.trainId[rideIndex]];
    if (train === null) return null;
    let day = Math.floor((ready - this.rides.arrOffset[rideIndex]) / 1440);
    if (day > train.endDay) day = train.endDay;
    while (day >= train.startDay) {
      const dep = day * 1440 + this.rides.depOffset[rideIndex];
      const arr = day * 1440 + this.rides.arrOffset[rideIndex];
      if (dep < floor) return null;
      if (arr <= ready && this.activeOn(train, day)) return { dep, arr };
      day--;
    }
    return null;
  }

  activeOn(train, serviceDay) {
    if (serviceDay < train.startDay || serviceDay > train.endDay) return false;
    if (train.ruleIndex < 0 || train.ruleIndex >= this.rules.length) return true;
    const rule = this.rules[train.ruleIndex];
    const period = rule.period === 0 ? 1 : rule.period;
    const days = serviceDay - train.startDay;
    const mod = ((days % period) + period) % period;
    let bit = 1;
    for (let i = 0; i < mod; i++) bit *= 2;
    return period === 1 || (bit & rule.mask) !== 0;
  }
}

class State {
  constructor(station, time, legs, wait, prev, next, ride, rideDep, rideArr,
    walkTotal = 0, walkCount = 0, lastWalk = false, boardFrom = time, walkInLeg = null, walkOutLeg = null) {
    this.station = station;
    this.time = time;
    this.legs = legs;
    this.wait = wait;
    this.prev = prev;
    this.next = next;
    this.ride = ride;
    this.rideDep = rideDep;
    this.rideArr = rideArr;
    this.walkTotal = walkTotal;
    this.walkCount = walkCount;
    this.lastWalk = lastWalk;
    this.boardFrom = boardFrom;
    this.walkInLeg = walkInLeg;
    this.walkOutLeg = walkOutLeg;
    this.live = true;
  }
}

class SearchResult {
  constructor(legs) { this.legs = legs; }
  departureTime() { return this.legs[0].dep; }
  arrivalTime() { return this.legs[this.legs.length - 1].arr; }
  trainLegs() { return this.legs.filter((l) => !l.walk).length; }
  walkLegs() { return this.legs.filter((l) => l.walk).length; }
  totalWait() {
    let w = 0;
    for (let i = 0; i + 1 < this.legs.length; i++) w += this.legs[i + 1].dep - this.legs[i].arr;
    return w;
  }
}

function dominatesForward(a, b) {
  if (a.time > b.time || a.legs > b.legs) return false;
  if (a.legs < b.legs) return true;
  return a.wait - a.time >= b.wait - b.time;
}

function dominatesBackward(a, b) {
  if (a.time < b.time || a.legs > b.legs) return false;
  if (a.legs < b.legs) return true;
  return a.wait + a.time >= b.wait + b.time;
}

function addLabel(labels, state, dominates) {
  let list = labels[state.station];
  if (list === null) labels[state.station] = (list = []);
  for (const old of list) if (old.live && dominates(old, state)) return false;
  for (let i = list.length - 1; i >= 0; i--) {
    const old = list[i];
    if (!old.live || dominates(state, old)) {
      old.live = false;
      list.splice(i, 1);
    }
  }
  list.push(state);
  return true;
}

function betterResult(a, b, byArrival) {
  if (a === null) return false;
  if (b === null) return true;
  const at = byArrival ? a.arrivalTime() : a.departureTime();
  const bt = byArrival ? b.arrivalTime() : b.departureTime();
  if (at !== bt) return byArrival ? at < bt : at > bt;
  const al = a.trainLegs(), bl = b.trainLegs();
  if (al !== bl) return al < bl;
  const aw = a.walkLegs(), bw = b.walkLegs();
  if (aw !== bw) return aw < bw;
  return a.totalWait() > b.totalWait();
}

/** 最小堆 */
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

function splitTsv(line) {
  const out = [];
  let sb = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') { sb += '"'; i++; } else { quoted = false; }
      } else sb += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === '\t') {
      out.push(sb);
      sb = '';
    } else sb += ch;
  }
  out.push(sb);
  return out;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
}

function trimNum(v) {
  return v === Math.floor(v) ? String(v) : String(v);
}

/** yyyyMMddhhmm -> 绝对分钟（epochDay * 1440 + h * 60 + m） */
export function toAbsMinute(time) {
  const y = +time.slice(0, 4), mo = +time.slice(4, 6), d = +time.slice(6, 8);
  const h = +time.slice(8, 10), mi = +time.slice(10, 12);
  return Math.floor(Date.UTC(y, mo - 1, d) / 86400000) * 1440 + h * 60 + mi;
}

export function formatTime(absMinute) {
  const day = Math.floor(absMinute / 1440);
  const minute = ((absMinute % 1440) + 1440) % 1440;
  const dt = dayToDate(day);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())} ${p2(Math.floor(minute / 60))}:${p2(minute % 60)}`;
}

export function formatDuration(minutes) {
  const days = Math.trunc(minutes / 1440);
  const rem = minutes % 1440;
  const hours = Math.trunc(rem / 60);
  const mins = rem % 60;
  const minText = (hours > 0 || days > 0) ? `${String(mins).padStart(2, '0')}分钟` : `${mins}分钟`;
  if (days > 0) return `${days}天${hours}小时${minText}`;
  if (hours > 0) return `${hours}小时${minText}`;
  return minText;
}

export function trimNumPublic(v) { return trimNum(v); }

/** 结果文本：与 Java formatResult 一致，用于对拍与网页文本视图 */
export function formatResult(engine, result) {
  if (result === null || result.legs.length === 0) return '未找到可行方案';
  const legs = result.legs;
  const depart = legs[0].dep, arrive = legs[legs.length - 1].arr;
  let trains = 0, walks = 0, walkMinutes = 0, walkKm = 0;
  for (const l of legs) {
    if (l.walk) { walks++; walkMinutes += l.arr - l.dep; walkKm += l.km; } else trains++;
  }
  let wait = 0;
  for (let i = 0; i + 1 < legs.length; i++) wait += legs[i + 1].dep - legs[i].arr;
  const sb = [];
  sb.push('方案:');
  sb.push(`  出发时间: ${formatTime(depart)}  ${engine.stationName(legs[0].from)}`);
  sb.push(`  到达时间: ${formatTime(arrive)}  ${engine.stationName(legs[legs.length - 1].to)}`);
  let head = `  总历时: ${formatDuration(arrive - depart)}, 换乘${Math.max(0, trains - 1)}次`;
  if (walks > 0) head += `, 邻站接驳${walks}次 (约${trimNum(Math.round(walkKm * 10) / 10)}公里)`;
  head += `, 换乘等待时间合计 ${formatDuration(wait)}`;
  if (walks > 0) head += `, 接驳耗时合计 ${formatDuration(walkMinutes)}`;
  sb.push(head);
  sb.push('');
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.walk) {
      sb.push(`${i + 1}. [邻站接驳]  ${engine.stationName(leg.from)} ${formatTime(leg.dep)} -> ${engine.stationName(leg.to)} ${formatTime(leg.arr)}  约${trimNum(Math.round(leg.km * 10) / 10)}公里`);
    } else {
      sb.push(`${i + 1}. ${engine.trainName(engine.rides.trainId[leg.ride])}  ${engine.stationName(leg.from)} ${formatTime(leg.dep)} -> ${engine.stationName(leg.to)} ${formatTime(leg.arr)}  历时 ${formatDuration(leg.arr - leg.dep)}`);
    }
    if (i + 1 < legs.length) sb.push(`   衔接时间: ${formatDuration(legs[i + 1].dep - leg.arr)}`);
  }
  return sb.join('\n');
}
