package szmetro;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;
import java.util.TreeSet;

/**
 * 时间相关（time-dependent）最短路，多条可行经由时按字典序取舍：
 *   1. 时间：出发查询取最早到达；到达查询取最晚出发（对候选发车时刻二分）
 *   2. 换乘间隔合计最长（上一段下车到下一班上车的间隔之和，含换乘走行时间）
 *   3. 换乘次数最少
 *
 * 状态 = (车站, 所在走廊, 是否刚换乘到站台)：到达某站后可 ① 乘坐所在走廊任一方向
 * （等下一班，刚换乘时的候车计入换乘间隔），② 在同名站换乘其他走廊（加换乘时间），
 * 或 ③ 起点站直接选择任一走廊（不计换乘时间）。
 * 乘车耗时 = 等待下一班 + 官网同线站对乘车时间；一次上车可乘坐至该方向任意下游站。
 *
 * 代价为三元组字典序，采用标号修正法（SPFA 风格）迭代松弛至收敛，
 * 保证在"时间相同、间隔更长"的改进路径出现时不会漏解。
 */
public final class Router {
    private static final int START = -1;
    private static final int TYPE_START = 0, TYPE_RIDE = 1, TYPE_TRANSFER = 2;

    /** 一段连续同走廊同方向的行程：boardSec 为该班车上车站的发车时刻 */
    public static final class Leg {
        public final int corridorId, dir, boardSec;
        public final List<Integer> stopGids = new ArrayList<>();
        public final List<Integer> stopArriveSec = new ArrayList<>();
        Network.Run run;   // 所乘列车；toPos 为下车站在该车停站序列中的下标
        int toPos = -1;

        Leg(int corridorId, int dir, int boardSec) {
            this.corridorId = corridorId;
            this.dir = dir;
            this.boardSec = boardSec;
        }
    }

    public record Transfer(int gid, int platformSec) {}

    /** 方案比较键：时间小者优 → 换乘间隔合计大者优 → 换乘次数小者优 */
    private static final class Cost {
        final int time;   // 到达终点（或当前状态）的时刻
        final int gap;    // 已累计的换乘候车余量（秒，走行时间固定不计入）
        final int count;  // 已累计的换乘次数

        Cost(int time, int gap, int count) {
            this.time = time;
            this.gap = gap;
            this.count = count;
        }

        int compareTo(Cost o) {
            if (time != o.time) return Integer.compare(time, o.time);
            if (gap != o.gap) return Integer.compare(o.gap, gap); // 间隔大者优
            return Integer.compare(count, o.count);
        }
    }

    public static final class Plan {
        public final int startSec;      // 乘客到达出发站站台的时刻
        public int boardSec;            // 实际首班发车时刻
        public final int arriveSec;     // 到达终点站时刻
        public final List<Object> rows = new ArrayList<>(); // Leg / Transfer 按行程顺序

        Plan(int startSec, int boardSec, int arriveSec) {
            this.startSec = startSec;
            this.boardSec = boardSec;
            this.arriveSec = arriveSec;
        }

        public int transferCount() {
            return (int) rows.stream().filter(r -> r instanceof Transfer).count();
        }

        /** 换乘候车余量合计：各次换乘走上站台后到发车的候车时间之和（走行时间固定，不计入） */
        public int transferWaitSec(int transferSec) {
            int gap = 0, prevArrive = -1;
            for (Object row : rows) {
                if (row instanceof Leg leg) {
                    if (prevArrive >= 0) gap += (leg.boardSec - prevArrive) - transferSec;
                    prevArrive = leg.stopArriveSec.get(leg.stopArriveSec.size() - 1);
                }
            }
            return gap;
        }

        /** 乘车区间数（经由站数） */
        public int rideStopCount() {
            int n = 0;
            for (Object row : rows) if (row instanceof Leg leg) n += leg.stopGids.size() - 1;
            return n;
        }
    }

    private final Network net;
    private final int weekday;
    private final int transferSec;

    public Router(Network net, int weekday, int transferSec) {
        this.net = net;
        this.weekday = weekday;
        this.transferSec = transferSec;
    }

    /** 状态键：车站 << 7 | (走廊+2) | 是否刚换乘(bit6) */
    private static long key(int gid, int corridor, boolean afterTransfer) {
        return ((long) gid << 7) | (corridor + 2) | (afterTransfer ? 0x40 : 0);
    }

    private static final class Edge {
        final int type;
        final long fromKey;                // 来源状态键（含'刚换乘'标记，用于回溯）
        final int fromGid, fromCorridor;
        final int corridorId, dir, toGid, departSec, arriveSec;
        final Network.Run run;             // 乘车段所属列车；起讫在该车停站序列中的下标
        final int fromPos, toPos;

        Edge(int type, long fromKey, int fromGid, int fromCorridor,
             int corridorId, int dir, int toGid, int departSec, int arriveSec) {
            this(type, fromKey, fromGid, fromCorridor, corridorId, dir, toGid, departSec, arriveSec, null, -1, -1);
        }

        Edge(int type, long fromKey, int fromGid, int fromCorridor,
             int corridorId, int dir, int toGid, int departSec, int arriveSec,
             Network.Run run, int fromPos, int toPos) {
            this.type = type;
            this.fromKey = fromKey;
            this.fromGid = fromGid;
            this.fromCorridor = fromCorridor;
            this.corridorId = corridorId;
            this.dir = dir;
            this.toGid = toGid;
            this.departSec = departSec;
            this.arriveSec = arriveSec;
            this.run = run;
            this.fromPos = fromPos;
            this.toPos = toPos;
        }
    }

    /** 给定最早出发时刻，返回按字典序最优的方案；不可达返回 null */
    public Plan routeDepart(int fromGid, int toGid, int startSec) {
        if (fromGid == toGid) return new Plan(startSec, startSec, startSec);

        Map<Long, Cost> best = new HashMap<>();
        Map<Long, Edge> parent = new HashMap<>();
        PriorityQueue<Object[]> pq = new PriorityQueue<>((a, b) -> ((Cost) a[0]).compareTo((Cost) b[0]));
        long startKey = key(fromGid, START, false);
        Cost start = new Cost(startSec, 0, 0);
        best.put(startKey, start);
        pq.add(new Object[]{start, startKey});

        while (!pq.isEmpty()) {
            Object[] cur = pq.poll();
            Cost c = (Cost) cur[0];
            long k = (long) cur[1];
            if (best.get(k) != c) continue; // 已被更优代价取代的过期条目

            int gid = (int) (k >> 7);
            int corridor = (int) (k & 0x3F) - 2;
            boolean afterTransfer = (k & 0x40) != 0;

            if (corridor == START) {
                for (int l : net.corridorsAtStation.getOrDefault(gid, Set.of())) {
                    relax(best, parent, pq, key(gid, l, false),
                            new Cost(c.time, c.gap, c.count),
                            new Edge(TYPE_START, k, gid, START, l, -1, gid, c.time, c.time));
                }
            } else {
                int idx = net.stopIndex(corridor, gid);
                List<Integer> stops = net.corridors.get(corridor).stopGids();
                for (int dir = 0; dir <= 1; dir++) {
                    List<Network.Boarding> list = net.boardings(corridor, dir, idx, weekday);
                    int b = firstAtOrAfter(list, c.time);
                    if (b < 0) continue;
                    int reachable = net.reachCount(corridor, dir, idx, weekday);
                    Set<Integer> covered = new HashSet<>();
                    // 按发车顺序逐班展开；某站首次出现即为最早到达（无越行），此后各班的同一站不再松弛
                    for (int bi = b; bi < list.size() && covered.size() < reachable; bi++) {
                        Network.Boarding bd = list.get(bi);
                        int gapAdd = afterTransfer ? bd.dep - c.time : 0;
                        for (int s = bd.pos + 1; s < bd.run.size(); s++) {
                            int nidx = bd.run.idx[s];
                            if (!covered.add(nidx)) continue;
                            int arrive = bd.run.sec[s];
                            relax(best, parent, pq, key(stops.get(nidx), corridor, false),
                                    new Cost(arrive, c.gap + gapAdd, c.count),
                                    new Edge(TYPE_RIDE, k, gid, corridor, corridor, dir, stops.get(nidx),
                                            bd.dep, arrive, bd.run, bd.pos, s));
                        }
                    }
                }
                for (int m : net.corridorsAtStation.getOrDefault(gid, Set.of())) {
                    if (m == corridor) continue;
                    relax(best, parent, pq, key(gid, m, true),
                            new Cost(c.time + transferSec, c.gap, c.count + 1),
                            new Edge(TYPE_TRANSFER, k, gid, corridor, m, -1, gid, c.time, c.time + transferSec));
                }
            }
        }

        long bestKey = -1;
        Cost bestCost = null;
        for (var e : best.entrySet()) {
            if ((int) (e.getKey() >> 7) != toGid) continue;
            if (bestCost == null || e.getValue().compareTo(bestCost) < 0) {
                bestCost = e.getValue();
                bestKey = e.getKey();
            }
        }
        if (bestKey < 0) return null;
        return buildPlan(parent, bestKey, startSec, bestCost.time);
    }

    /** 给定到达时限，返回"最晚出发仍不迟到"的方案；无法按时到达返回 null */
    public Plan routeArrive(int fromGid, int toGid, int deadlineSec) {
        TreeSet<Integer> cands = new TreeSet<>();
        for (int c : net.corridorsAtStation.getOrDefault(fromGid, Set.of())) {
            int idx = net.stopIndex(c, fromGid);
            for (int dir = 0; dir <= 1; dir++)
                for (int sec : net.table(c, idx, weekday, dir)) cands.add(sec);
        }
        if (cands.isEmpty()) return null;
        List<Integer> cs = new ArrayList<>(cands);

        Plan first = routeDepart(fromGid, toGid, cs.get(0));
        if (first == null || first.arriveSec > deadlineSec) return null;

        Plan bestPlan = first;
        int lo = 0, hi = cs.size() - 1;
        while (lo <= hi) {
            int mid = (lo + hi) >>> 1;
            Plan p = routeDepart(fromGid, toGid, cs.get(mid));
            if (p != null && p.arriveSec <= deadlineSec) {
                bestPlan = p;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return bestPlan;
    }

    private void relax(Map<Long, Cost> best, Map<Long, Edge> parent, PriorityQueue<Object[]> pq,
                       long nKey, Cost nc, Edge e) {
        Cost old = best.get(nKey);
        if (old != null && old.compareTo(nc) <= 0) return;
        best.put(nKey, nc);
        parent.put(nKey, e);
        pq.add(new Object[]{nc, nKey});
    }

    private Plan buildPlan(Map<Long, Edge> parent, long endKey, int startSec, int arriveSec) {
        List<Edge> chain = new ArrayList<>();
        for (long k = endKey; ; ) {
            Edge e = parent.get(k);
            if (e == null) break;
            chain.add(e);
            if (e.type == TYPE_START) break;
            k = e.fromKey;
        }
        Collections.reverse(chain);

        Plan plan = new Plan(startSec, -1, arriveSec);
        for (Edge e : chain) {
            if (e.type == TYPE_TRANSFER) {
                plan.rows.add(new Transfer(e.fromGid, e.arriveSec));
            } else if (e.type == TYPE_RIDE) {
                // 同一列车继续乘坐（枚举会把一段车拆成多步）
                if (!plan.rows.isEmpty() && plan.rows.get(plan.rows.size() - 1) instanceof Leg last
                        && last.run == e.run && last.toPos == e.fromPos
                        && last.boardSec == e.run.sec[e.fromPos]) {
                    extendLeg(net, last, e);
                } else {
                    Leg leg = newLeg(net, e);
                    plan.rows.add(leg);
                    if (plan.boardSec < 0) plan.boardSec = e.departSec;
                }
            }
            // TYPE_START：起点选走廊，仅决定首段从哪条线出发，不产生输出行
        }
        return plan;
    }

    /** 新建一段行程：取该班车实际停靠的站序与时刻 */
    private Leg newLeg(Network net, Edge e) {
        var c = net.corridors.get(e.corridorId);
        Leg leg = new Leg(e.corridorId, e.dir, e.departSec);
        leg.run = e.run;
        leg.toPos = e.toPos;
        for (int s = e.fromPos; s <= e.toPos; s++) leg.stopGids.add(c.stopGids().get(e.run.idx[s]));
        for (int s = e.fromPos + 1; s <= e.toPos; s++) leg.stopArriveSec.add(e.run.sec[s]);
        return leg;
    }

    /** 延长一段行程至 e.toPos */
    private void extendLeg(Network net, Leg leg, Edge e) {
        var c = net.corridors.get(e.corridorId);
        for (int s = e.fromPos + 1; s <= e.toPos; s++) {
            leg.stopGids.add(c.stopGids().get(e.run.idx[s]));
            leg.stopArriveSec.add(e.run.sec[s]);
        }
        leg.toPos = e.toPos;
    }

    /** 可上列车列表（按发车升序）中第一个 dep >= t 的下标；无则 -1 */
    static int firstAtOrAfter(List<Network.Boarding> list, int t) {
        int lo = 0, hi = list.size();
        while (lo < hi) {
            int mid = (lo + hi) >>> 1;
            if (list.get(mid).dep < t) lo = mid + 1; else hi = mid;
        }
        return lo < list.size() ? lo : -1;
    }
}
