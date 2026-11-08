package szmetro;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * 路网数据：走廊（车站有序表，贯通运营的菜单线路已合并）、同名车站的跨走廊换乘关系、
 * 以及各 走廊×车站×星期×方向 的发车时刻表（来自网站，每站独立）。
 *
 * 站间运行时间与换乘时间不在网站数据中，由查询参数指定（Router 使用）。
 */
public final class Network {
    public record Corridor(int id, List<Integer> menuLineIds, List<Integer> stopGids,
                           List<String> stopNames, String d0Label, String d1Label) {
        public String displayName() {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < menuLineIds.size(); i++) {
                if (i > 0) sb.append('/');
                sb.append(menuLineIds.get(i)).append("号线");
            }
            return sb.toString();
        }
    }

    public final Map<Integer, Corridor> corridors = new TreeMap<>();
    /** 车站名 -> 全局站点 id（同名即同一站点，可换乘） */
    public final Map<String, Integer> gidOfName = new LinkedHashMap<>();
    public final List<String> nameOfGid = new ArrayList<>();
    /** 站点 id -> 经过该站的走廊 id 集合 */
    public final Map<Integer, Set<Integer>> corridorsAtStation = new HashMap<>();
    /** "走廊|站序|星期" -> [方向0时刻[], 方向1时刻[]]（秒，升序去重） */
    public final Map<String, int[][]> tables = new HashMap<>();
    /** 走廊 -> 站对运行时间矩阵 [i][j] = 第 i 站乘到第 j 站的官网同线时间（秒），-1 = 无数据 */
    public final Map<Integer, int[][]> pairMatrix = new HashMap<>();
    /** 星期 -> 列车运行图索引（懒构建，算法与 site/metro/engine.js 的 buildRuns 逐行一致） */
    private final Map<Integer, WeekRuns> weekRuns = new HashMap<>();
    /** 运营配置（折返站/段终点/贯通关系/相邻站时间覆盖） */
    public final Ops ops = new Ops();

    /** 一列车的停站序列：idx[k] 走廊站序，sec[k] 时刻（末站为到达时刻，非发车） */
    public static final class Run {
        public final int[] idx, sec;
        Run(int[] idx, int[] sec) { this.idx = idx; this.sec = sec; }
        public int size() { return idx.length; }
    }

    /** 某站可上车的一班车：dep 发车秒，run 所属运行图，pos 上车在该车停站序列中的下标 */
    public static final class Boarding {
        public final int dep, pos;
        public final Run run;
        Boarding(int dep, int pos, Run run) { this.dep = dep; this.pos = pos; this.run = run; }
    }

    /** 某星期的运行图：cid|dir -> 列车列表；cid|dir|idx -> 可上车列表（升序）；cid|dir|idx -> 可达下游站数 */
    public static final class WeekRuns {
        final Map<String, List<Run>> runs = new HashMap<>();
        final Map<String, List<Boarding>> boardAt = new HashMap<>();
        final Map<String, Integer> reachAt = new HashMap<>();
    }

    /** 运营配置（cache/operations.txt）：折返站 / 段终点 / 贯通接续 / 相邻站时间覆盖 */
    public static final class Ops {
        final Map<String, List<String[]>> turnbacks = new HashMap<>();     // "cid|dir" -> [折返站名, fast]
        final Map<String, List<String[]>> termini = new HashMap<>();      // "cid|dir" -> [起点站, 段终点]
        final List<String[]> through = new ArrayList<>();                 // [cidA, dirA, 贯通站, cidB, dirB]
        final Map<String, Map<String, Integer>> hops = new HashMap<>();   // "cid|dir" -> "站A→站B" -> 分钟
    }

    /** 官网站名用「/」分隔（苏州园区/火车站、陆慕/古巷），时刻表来源是连写，统一去掉「/」再匹配 */
    static String normName(String s) { return s.replace("/", ""); }

    public static Network load(Path cacheDir) throws IOException {
        Network n = new Network();
        Path corF = cacheDir.resolve("corridors.txt");
        Path staF = cacheDir.resolve("stations.txt");
        if (!Files.exists(corF) || !Files.exists(staF))
            throw new IOException("缓存缺少走廊/车站数据，请先执行 crawl");

        Map<Integer, List<Integer>> corMenuLines = new TreeMap<>();
        for (String ln : Files.readAllLines(corF, StandardCharsets.UTF_8)) {
            if (ln.isBlank()) continue;
            String[] p = ln.split("\t");
            List<Integer> ids = new ArrayList<>();
            for (String s : p[1].split(",")) ids.add(Integer.parseInt(s));
            corMenuLines.put(Integer.parseInt(p[0]), ids);
        }

        Map<Integer, List<String[]>> ordered = new TreeMap<>();
        for (String ln : Files.readAllLines(staF, StandardCharsets.UTF_8)) {
            if (ln.isBlank()) continue;
            String[] p = ln.split("\t", 4);
            int cid = Integer.parseInt(p[0]);
            int idx = Integer.parseInt(p[1]);
            String name = p[3].trim();
            ordered.computeIfAbsent(cid, k -> new ArrayList<>());
            List<String[]> sts = ordered.get(cid);
            if (idx != sts.size())
                throw new IOException("走廊 " + cid + " 站点序号不连续: " + name);
            sts.add(new String[]{p[2], name});
        }

        for (var e : ordered.entrySet()) {
            int cid = e.getKey();
            List<String[]> rows = e.getValue();
            List<Integer> gids = new ArrayList<>();
            List<String> names = new ArrayList<>();
            for (String[] r : rows) {
                String name = r[1];
                Integer gid = n.gidOfName.get(name);
                if (gid == null) {
                    gid = n.nameOfGid.size();
                    n.gidOfName.put(name, gid);
                    n.nameOfGid.add(name);
                }
                gids.add(gid);
                names.add(name);
                n.corridorsAtStation.computeIfAbsent(gid, k -> new TreeSet<>()).add(cid);
            }
            n.corridors.put(cid, new Corridor(cid, corMenuLines.get(cid), gids, names, null, null));
        }

        // 时刻表文件：tt_{c}_{idx}_w{W}.txt，头行含方向标签，数据行 "dir\thour\t分钟..."
        Map<Integer, String> d0Label = new HashMap<>(), d1Label = new HashMap<>();
        try (var files = Files.list(cacheDir)) {
            for (Path f : (Iterable<Path>) files.filter(p -> {
                String fn = p.getFileName().toString();
                return fn.startsWith("tt_") && fn.endsWith(".txt");
            })::iterator) {
                String fn = f.getFileName().toString(); // tt_{c}_{idx}_w{W}.txt
                String[] parts = fn.substring(3, fn.length() - 4).split("_");
                int cid = Integer.parseInt(parts[0]);
                int idx = Integer.parseInt(parts[1]);
                int weekday = Integer.parseInt(parts[2].substring(1));
                int[][] tt = {new int[0], new int[0]};
                for (String ln : Files.readAllLines(f, StandardCharsets.UTF_8)) {
                    if (ln.isBlank()) continue;
                    if (ln.startsWith("#")) {
                        int li = ln.indexOf("labels=");
                        if (li >= 0) {
                            // labels=0:X|1:Y（其后可能还有 src= 等字段，截到空白为止）
                            String tail = ln.substring(li + 7).trim();
                            int sp = tail.indexOf(' ');
                            String labs = sp >= 0 ? tail.substring(0, sp) : tail;
                            String[] seg = labs.split("\\|");
                            for (String seg1 : seg) {
                                String[] kv = seg1.split(":", 2);
                                if (kv.length == 2) {
                                    if (kv[0].equals("0")) d0Label.putIfAbsent(cid, kv[1].trim());
                                    if (kv[0].equals("1")) d1Label.putIfAbsent(cid, kv[1].trim());
                                }
                            }
                        }
                        continue;
                    }
                    String[] p = ln.trim().split("\t");
                    int dir = Integer.parseInt(p[0]);
                    int hour = Integer.parseInt(p[1]);
                    if (dir < 0 || dir > 1 || hour < 0 || hour > 47) continue;
                    TreeSet<Integer> secs = new TreeSet<>();
                    for (int i = 2; i < p.length; i++) {
                        int minute = Integer.parseInt(p[i]);
                        secs.add(hour * 3600 + minute * 60);
                    }
                    int[][] merged = {tt[0], tt[1]};
                    TreeSet<Integer> all = new TreeSet<>();
                    for (int v : merged[dir]) all.add(v);
                    all.addAll(secs);
                    merged[dir] = all.stream().mapToInt(Integer::intValue).toArray();
                    tt = merged;
                }
                n.tables.put(cid + "|" + idx + "|" + weekday, tt);
            }
        }

        for (var e : n.corridors.entrySet()) {
            int cid = e.getKey();
            Corridor old = e.getValue();
            List<String> names = old.stopNames();
            String l0 = d0Label.get(cid), l1 = d1Label.get(cid);
            // 方向标签（往某站）取自时刻表；校验其必须是走廊端点，防止站序或标签错乱
            if (l0 != null && !l0.equals(names.get(0)) && !l0.equals(names.get(names.size() - 1)))
                throw new IOException("走廊 " + cid + " 方向标签(" + l0 + "/" + l1
                        + ")与车站端点(" + names.get(0) + "/" + names.get(names.size() - 1) + ")不匹配");
            if (l0 != null)
                n.corridors.put(cid, new Corridor(cid, old.menuLineIds(), old.stopGids(), names, l0, l1));
        }

        // 站点页把跨零点的末班车放在「0 时」块（排在 23 时之后）；解析后按 0:xx 记录，
        // 载入时统一归入次日（4:00 前不可能是正常首班车），避免与清晨时刻混淆
        for (int[][] dirs : n.tables.values()) {
            for (int d = 0; d < 2; d++) {
                if (dirs[d] == null) continue;
                boolean changed = false;
                for (int i = 0; i < dirs[d].length; i++)
                    if (dirs[d][i] < 4 * 3600) { dirs[d][i] += 86400; changed = true; }
                if (changed) {
                    Arrays.sort(dirs[d]);
                    int m = 0;
                    for (int i = 0; i < dirs[d].length; i++)
                        if (i == 0 || dirs[d][i] != dirs[d][i - 1]) dirs[d][m++] = dirs[d][i];
                    dirs[d] = Arrays.copyOf(dirs[d], m);
                }
            }
        }

        // 官网同线站对时间：official_pairs.txt 行 = 线路名\t站A\t站B\tA->B分钟\tB->A分钟
        // official_lines.txt 行 = 线路名\t序号\t站名（确定线路内站序，用于方向换算）
        Path lineF = cacheDir.resolve("official_lines.txt");
        Path pairF = cacheDir.resolve("official_pairs.txt");
        Map<String, Map<String, Integer>> offPos = new HashMap<>();   // 线路名 -> (站名 -> 线内序号)
        Map<String, int[][][]> offPair = new HashMap<>();             // 线路名 -> 三角矩阵 [i][j] = {i->j 秒, j->i 秒}
        if (Files.exists(lineF)) {
            Map<String, List<String>> order = new LinkedHashMap<>();
            for (String ln : Files.readAllLines(lineF, StandardCharsets.UTF_8)) {
                if (ln.isBlank()) continue;
                String[] p = ln.split("\t", 3);
                order.computeIfAbsent(p[0], k -> new ArrayList<>()).add(Integer.parseInt(p[1]), p[2]);
            }
            for (var e : order.entrySet()) {
                Map<String, Integer> pos = new HashMap<>();
                for (int i = 0; i < e.getValue().size(); i++) pos.put(normName(e.getValue().get(i)), i);
                offPos.put(e.getKey(), pos);
                offPair.put(e.getKey(), new int[e.getValue().size()][e.getValue().size()][2]);
            }
        }
        if (Files.exists(pairF)) {
            for (String ln : Files.readAllLines(pairF, StandardCharsets.UTF_8)) {
                if (ln.isBlank()) continue;
                String[] p = ln.split("\t", 5);
                if (p.length < 5) continue;
                Map<String, Integer> pos = offPos.get(p[0]);
                int[][][] tri = offPair.get(p[0]);
                if (pos == null || tri == null) continue;
                Integer pi = pos.get(normName(p[1])), pj = pos.get(normName(p[2]));
                if (pi == null || pj == null || pi >= pj) continue;
                if (!p[3].isBlank()) tri[pi][pj][0] = Integer.parseInt(p[3]) * 60;
                if (!p[4].isBlank()) tri[pi][pj][1] = Integer.parseInt(p[4]) * 60;
            }
        }

        // 每走廊构建站对时间矩阵 matrix[i][j] = 从第 i 站乘到第 j 站的官网同线时间（秒），-1 = 无数据。
        // 走廊由菜单线路组成（3/11 贯通走廊对应官网 3号线 + 11号线两段），
        // 站对只要同属一条相关官网线路即采信（方向按官网线路序换算）。
        for (var e : n.corridors.entrySet()) {
            int cid = e.getKey();
            List<String> names = e.getValue().stopNames();
            int sz = names.size();
            int[][] mat = new int[sz][sz];
            for (int[] row : mat) Arrays.fill(row, -1);
            record CorrLine(Map<String, Integer> offIdx, boolean sameDir) {}
            // 用 LinkedHashMap 保证按 menuLineIds 顺序选取，与 JS 版一致（跨线共享站对取先出现的线路）
            Map<String, CorrLine> corrLines = new LinkedHashMap<>(); // 官网线路名 -> (站名 -> 官网线内序号, 与走廊同向?)
            for (int menuLine : e.getValue().menuLineIds()) {
                String lname = menuLine + "号线";
                Map<String, Integer> pos = offPos.get(lname);
                if (pos == null) continue;
                Map<String, Integer> offIdx = new HashMap<>();
                int minCorr = Integer.MAX_VALUE, maxCorr = -1;
                int firstOffIdx = -1, lastOffIdx = -1;
                int n_ = pos.size();
                for (var pe : pos.entrySet()) {
                    int cIdx = names.indexOf(pe.getKey()); // names 来自时刻表，无「/」
                    if (cIdx < 0) continue;
                    offIdx.put(pe.getKey(), pe.getValue());
                    if (pe.getValue() == 0) firstOffIdx = cIdx;
                    if (pe.getValue() == n_ - 1) lastOffIdx = cIdx;
                    minCorr = Math.min(minCorr, cIdx);
                    maxCorr = Math.max(maxCorr, cIdx);
                }
                // 官网线路序与走廊序是否同向（覆盖不完整时用首末站在走廊中的相对位置判断）
                boolean sameDir = firstOffIdx < 0 || lastOffIdx < 0
                        ? minCorr <= maxCorr : firstOffIdx <= lastOffIdx;
                if (!offIdx.isEmpty()) corrLines.put(lname, new CorrLine(offIdx, sameDir));
            }
            for (int i = 0; i < sz; i++) {
                for (int j = i + 1; j < sz; j++) {
                    for (var ce : corrLines.entrySet()) {
                        Integer pi = ce.getValue().offIdx().get(normName(names.get(i)));
                        Integer pj = ce.getValue().offIdx().get(normName(names.get(j)));
                        if (pi == null || pj == null || pi.equals(pj)) continue;
                        int[][][] tri = offPair.get(ce.getKey());
                        int hi = Math.min(pi, pj), lo = Math.max(pi, pj);
                        int fwd = tri[hi][lo][0]; // 官网序 hi -> lo
                        int bwd = tri[hi][lo][1]; // 官网序 lo -> hi
                        if (fwd <= 0 && bwd <= 0) continue;
                        boolean sameDir = ce.getValue().sameDir();
                        int ij = (pi < pj) == sameDir ? fwd : bwd;  // 走廊 i -> j
                        int ji = (pi < pj) == sameDir ? bwd : fwd;  // 走廊 j -> i
                        if (ij > 0) mat[i][j] = ij;
                        if (ji > 0) mat[j][i] = ji;
                        break;
                    }
                }
            }
            n.pairMatrix.put(cid, mat);
        }
        // 运营配置：cache/operations.txt（制表符分隔，^# 注释）
        Path opsF = cacheDir.resolve("operations.txt");
        if (Files.exists(opsF)) {
            for (String ln : Files.readAllLines(opsF, StandardCharsets.UTF_8)) {
                if (ln.isBlank() || ln.startsWith("#")) continue;
                String[] p = ln.split("	");
                if (p.length < 4) continue;
                switch (p[0]) {
                    case "turnback" -> n.ops.turnbacks.computeIfAbsent(p[1] + "|" + p[2], k -> new ArrayList<>()).add(new String[]{p[3], p.length >= 5 && p[4].equals("fast") ? "1" : ""});
                    case "terminus" -> {
                        if (p.length >= 5) n.ops.termini.computeIfAbsent(p[1] + "|" + p[2], k -> new ArrayList<>()).add(new String[]{p[3], p[4]});
                    }
                    case "through" -> {
                        if (p.length >= 6) n.ops.through.add(new String[]{p[1], p[2], p[3], p[4], p[5]});
                    }
                    case "hop" -> {
                        if (p.length >= 6) n.ops.hops.computeIfAbsent(p[1] + "|" + p[2], k -> new HashMap<>()).put(p[3] + "→" + p[4], Integer.parseInt(p[5]));
                    }
                    default -> { }
                }
            }
        }
        return n;
    }

    /** 某走廊某方向某站可上的列车（按发车时刻升序） */
    public List<Boarding> boardings(int cid, int dir, int idx, int weekday) {
        return runs(weekday).boardAt.getOrDefault(cid + "|" + dir + "|" + idx, List.of());
    }

    /** 某站起该方向可达的下游站数（用于提前结束逐班展开） */
    public int reachCount(int cid, int dir, int idx, int weekday) {
        return runs(weekday).reachAt.getOrDefault(cid + "|" + dir + "|" + idx, 0);
    }

    /** 某星期的运行图（首次调用时构建并缓存） */
    public WeekRuns runs(int weekday) {
        WeekRuns wr = weekRuns.get(weekday);
        if (wr == null) weekRuns.put(weekday, wr = buildRuns(weekday));
        return wr;
    }

    /**
     * 由逐站时刻表重建列车运行图（算法与 site/metro/engine.js 的 buildRuns 逐行一致）。
     * 站点页只列停靠时刻（大站快车跳过的站没有），终点站（含小交路终到站如 6 号线南斜步）不记到达时刻，因此：
     *   - 相邻站按「无越行」顺序配对：到达 = 本站发车 + 站间运行时间（hop 取官网站对，不准时用时刻表配对推算，
     *     运营配置可覆盖）；大站快车跳过的站按多站补链（最远 MAX_SKIP 站，扣除被跳过站的停站时间）；
     *   - 配对率过低（<80%）视为运营分界，不跨段串联（6 号线南斜步两段小交路即靠此判定）；
     *   - 终到：折返站（运营配置）直接终到；段终点（运营配置）前因数据缺失断链的沿 hop 链延伸到段终点
     *     （快车只记终点、普通车逐站推算）；其余推算到下一站；
     *   - 尾段合并：推算的到站值与下一站自成一列的短链首值接近时并入；
     *   - 跨走廊贯通（运营配置）：A 线到贯通站终到的列车由 B 线同向时刻吻合的列车接续。
     */
    private WeekRuns buildRuns(int weekday) {
        final int TOL = 60;
        final int MAX_SKIP = 6;
        final int DWELL = 60;
        final int SKIP_TOL = 120;
        final double MIN_RATE = 0.8;
        WeekRuns wr = new WeekRuns();
        Map<String, int[]> hopOf = new HashMap<>();
        for (var e : corridors.entrySet()) {
            int cid = e.getKey();
            List<String> names = e.getValue().stopNames();
            int N = names.size();
            int[][] mat = pairMatrix.get(cid);
            for (int dir = 0; dir <= 1; dir++) {
                int[] order = new int[N];
                for (int p = 0; p < N; p++) order[p] = dir == 0 ? p : N - 1 - p;
                int[][] deps = new int[N][];
                for (int p = 0; p < N; p++) deps[p] = table(cid, order[p], weekday, dir);
                int[] hop = new int[N - 1];
                for (int p = 0; p < N - 1; p++)
                    hop[p] = pickHop(deps[p], deps[p + 1], mat[order[p]][order[p + 1]], TOL);
                // 运营配置可显式指定相邻站运行时间（官网站对相邻值有 ±1 分钟噪声，可用长站对校准）
                Map<String, Integer> hopFix = ops.hops.getOrDefault(cid + "|" + dir, Map.of());
                for (var fe : hopFix.entrySet()) {
                    String[] ab = fe.getKey().split("→");
                    int pa = -1, pb = -1;
                    for (int p = 0; p < N; p++) {
                        if (names.get(order[p]).equals(ab[0])) pa = p;
                        if (names.get(order[p]).equals(ab[1])) pb = p;
                    }
                    if (pa >= 0 && pb == pa + 1) hop[pa] = fe.getValue() * 60;
                }
                hopOf.put(cid + "|" + dir, hop);

                // 相邻站配对：next[p][i] = p+1 站的下标，-1 表示该车不在下一站停靠
                int[][] next = new int[N][], prev = new int[N][], nextPos = new int[N][];
                boolean[] boundary = new boolean[N];
                for (int p = 0; p < N; p++) {
                    next[p] = new int[deps[p].length];
                    prev[p] = new int[deps[p].length];
                    nextPos[p] = new int[deps[p].length];
                    Arrays.fill(next[p], -1);
                    Arrays.fill(prev[p], -1);
                }
                for (int p = 0; p < N - 1; p++) {
                    if (deps[p].length == 0 || deps[p + 1].length == 0) { boundary[p] = true; continue; }
                    int[] a = deps[p], b = deps[p + 1];
                    int[][] pairs = matchPairs(a, b, hop[p], TOL);
                    double rate = Math.min((double) pairs.length / a.length, (double) pairs.length / b.length);
                    boundary[p] = rate < MIN_RATE;
                    if (boundary[p]) continue;
                    for (int[] pr : pairs) {
                        next[p][pr[0]] = pr[1];
                        nextPos[p][pr[0]] = p + 1;
                        prev[p + 1][pr[1]] = pr[0];
                    }
                }
                // 大站快车多站补链：本站有车、下游 k 站时刻吻合（扣除被跳过站停站时间），k 优先取小
                for (int p = 0; p < N; p++) {
                    for (int k = 2; k <= MAX_SKIP && p + k < N; k++) {
                        if (boundary[p + k - 1]) break;
                        for (int i = 0; i < deps[p].length; i++) {
                            if (next[p][i] >= 0) continue;
                            int expect = deps[p][i] - (k - 1) * DWELL;
                            for (int d = 0; d < k; d++) expect += hop[p + d];
                            for (int j = 0; j < deps[p + k].length; j++) {
                                if (prev[p + k][j] >= 0) continue;
                                if (Math.abs(deps[p + k][j] - expect) <= SKIP_TOL) {
                                    next[p][i] = j;
                                    nextPos[p][i] = p + k;
                                    prev[p + k][j] = i;
                                    break;
                                }
                            }
                        }
                    }
                }

                // 串联成列车
                List<Run> runs = new ArrayList<>();
                boolean[][] seen = new boolean[N][];
                for (int p = 0; p < N; p++) seen[p] = new boolean[deps[p].length];
                for (int p = 0; p < N; p++) {
                    for (int i = 0; i < deps[p].length; i++) {
                        if (seen[p][i] || prev[p][i] >= 0) continue;
                        IntList si = new IntList(), ss = new IntList();
                        int pp = p, ii = i;
                        while (pp >= 0) {
                            seen[pp][ii] = true;
                            si.add(order[pp]);
                            ss.add(deps[pp][ii]);
                            int nj = next[pp][ii];
                            int np = nextPos[pp][ii];
                            pp = nj >= 0 ? np : -1;
                            ii = nj;
                        }
                        runs.add(new Run(si.toArray(), ss.toArray()));
                    }
                }

                // 尾段合并（先于终到判定）：推算的下一站到达与自成一列的短链首值接近时并入本列
                boolean[] merged = new boolean[runs.size()];
                for (int ri = 0; ri < runs.size(); ri++) {
                    if (merged[ri]) continue;
                    Run run = runs.get(ri);
                    while (true) {
                        int p = posOf(dir, run.idx[run.size() - 1], N);
                        if (p >= N - 1) break;
                        int expect = run.sec[run.size() - 1] + hop[p];
                        int nextIdx = order[p + 1];
                        int hit = -1;
                        for (int rj = 0; rj < runs.size(); rj++) {
                            if (rj == ri || merged[rj]) continue;
                            Run frag = runs.get(rj);
                            if (frag.size() != 1 || frag.idx[0] != nextIdx) continue;
                            if (Math.abs(frag.sec[0] - expect) > SKIP_TOL) continue;
                            hit = rj;
                            break;
                        }
                        if (hit < 0) break;
                        Run frag = runs.get(hit);
                        IntList ni = new IntList(), ns = new IntList();
                        for (int i = 0; i < run.size(); i++) { ni.add(run.idx[i]); ns.add(run.sec[i]); }
                        for (int i = 0; i < frag.size(); i++) { ni.add(frag.idx[i]); ns.add(frag.sec[i]); }
                        run = new Run(ni.toArray(), ns.toArray());
                        runs.set(ri, run);
                        merged[hit] = true;
                    }
                }
                // 终到处理
                List<String[]> tbs = ops.turnbacks.getOrDefault(cid + "|" + dir, List.of());
                List<String[]> terms = ops.termini.getOrDefault(cid + "|" + dir, List.of());
                List<Run> finished = new ArrayList<>(runs.size());
                for (int ri = 0; ri < runs.size(); ri++) {
                    if (merged[ri]) continue;
                    Run run = runs.get(ri);
                    int lastIdx = run.idx[run.size() - 1];
                    boolean fast = false;
                    for (int i = 1; i < run.size(); i++)
                        if (run.idx[i] - run.idx[i - 1] != (dir == 0 ? 1 : -1)) { fast = true; break; }
                    boolean tb = false;
                    // 折返站：列车终到于此（带 fast 限定的只对越站快车生效）
                    for (String[] s : tbs)
                        if (names.get(lastIdx).equals(s[0]) && (s[1].isEmpty() || fast)) { tb = true; break; }
                    if (tb) { finished.add(run); continue; }
                    int term = -1;
                    for (String[] t : terms) {
                        int fromIdx = names.indexOf(t[0]), atIdx = names.indexOf(t[1]);
                        if (fromIdx < 0 || atIdx < 0) continue;
                        int ps = posOf(dir, run.idx[0], N), pl = posOf(dir, lastIdx, N);
                        if (ps >= posOf(dir, fromIdx, N) && ps < posOf(dir, atIdx, N) && pl < posOf(dir, atIdx, N)) {
                            term = atIdx;
                            break;
                        }
                    }
                    if (term >= 0) {
                        // 段终点前数据缺失：按 hop 链延伸到段终点；快车中间越站不记
                        IntList ni = new IntList(), ns = new IntList();
                        for (int i = 0; i < run.size(); i++) { ni.add(run.idx[i]); ns.add(run.sec[i]); }
                        int cur = lastIdx, time = run.sec[run.size() - 1];
                        while (cur != term) {
                            int p = posOf(dir, cur, N);
                            time += hop[p];
                            cur = order[p + 1];
                            if (!fast || cur == term) { ni.add(cur); ns.add(time); }
                        }
                        finished.add(new Run(ni.toArray(), ns.toArray()));
                        continue;
                    }
                    int p = posOf(dir, lastIdx, N);
                    if (p >= N - 1) { finished.add(run); continue; }
                    int[] ni = Arrays.copyOf(run.idx, run.size() + 1);
                    int[] ns = Arrays.copyOf(run.sec, run.size() + 1);
                    ni[run.size()] = order[p + 1];
                    ns[run.size()] = run.sec[run.size() - 1] + hop[p];
                    finished.add(new Run(ni, ns));
                }
                runs = finished;

                wr.runs.put(cid + "|" + dir, finished);
            }
        }

        // 跨走廊贯通接续
        for (String[] rel : ops.through) {
            int cidA = Integer.parseInt(rel[0]), dirA = Integer.parseInt(rel[1]);
            String at = rel[2];
            int cidB = Integer.parseInt(rel[3]), dirB = Integer.parseInt(rel[4]);
            if (!corridors.containsKey(cidA) || !corridors.containsKey(cidB)) continue;
            List<String> namesA = corridors.get(cidA).stopNames();
            List<String> namesB = corridors.get(cidB).stopNames();
            int atA = namesA.indexOf(at), atB = namesB.indexOf(at);
            if (atA < 0 || atB < 0) continue;
            int NB = namesB.size();
            int[] orderB = new int[NB];
            for (int p = 0; p < NB; p++) orderB[p] = dirB == 0 ? p : NB - 1 - p;
            int posB = -1;
            for (int p = 0; p < NB; p++) if (orderB[p] == atB) posB = p;
            if (posB < 0 || posB >= NB - 1) continue;
            int nextB = orderB[posB + 1];
            int hopB = hopOf.get(cidB + "|" + dirB)[posB];
            List<Run> runsB = wr.runs.get(cidB + "|" + dirB);
            List<Run> runsA = wr.runs.getOrDefault(cidA + "|" + dirA, List.of());
            if (runsB == null) continue;
            for (Run run : runsA) {
                int lastIdx = run.idx[run.size() - 1];
                if (lastIdx != atA) continue;
                int arrive = run.sec[run.size() - 1];
                int want = arrive + hopB;
                for (int rj = 0; rj < runsB.size(); rj++) {
                    Run cand = runsB.get(rj);
                    if (cand.idx[0] != nextB) continue;
                    int d = cand.sec[0] - want;
                    if (d < 0 || d > TOL) continue;
                    int[] ni = new int[cand.size() + 1], ns = new int[cand.size() + 1];
                    ni[0] = atB;
                    ns[0] = arrive;
                    System.arraycopy(cand.idx, 0, ni, 1, cand.size());
                    System.arraycopy(cand.sec, 0, ns, 1, cand.size());
                    runsB.set(rj, new Run(ni, ns));
                    break;
                }
            }
        }

        // 登记可上车次与可达站数
        for (var re : wr.runs.entrySet()) {
            for (Run run : re.getValue()) {
                for (int k = 0; k < run.size() - 1; k++) {  // 末站是到达，不能上车
                    wr.boardAt.computeIfAbsent(re.getKey() + "|" + run.idx[k], x -> new ArrayList<>())
                            .add(new Boarding(run.sec[k], k, run));
                }
            }
        }
        for (var e : wr.boardAt.entrySet()) {
            e.getValue().sort((x, y) -> Integer.compare(x.dep, y.dep));
            Set<Integer> seen = new HashSet<>();
            for (Boarding b : e.getValue())
                for (int s = b.pos + 1; s < b.run.size(); s++) seen.add(b.run.idx[s]);
            wr.reachAt.put(e.getKey(), seen.size());
        }
        return wr;
    }

    /** 走廊站序 idx 在该方向行进序列中的位置 */
    private static int posOf(int dir, int idx, int N) {
        return dir == 0 ? idx : N - 1 - idx;
    }

    /** 相邻段 hop：官网相邻时间优先；试遍 1..10 分钟，取配对数最多者（已全配对时立即返回） */
    private static int pickHop(int[] a, int[] b, int off, int tol) {
        if (a.length == 0 || b.length == 0) return off > 0 ? off : 120;
        int best = off > 0 ? off : 0, bestN = off > 0 ? countMatch(a, b, off, tol) : -1;
        if (bestN >= a.length) return best;
        for (int h = 60; h <= 600; h += 60) {
            int n = countMatch(a, b, h, tol);
            if (n > bestN) { bestN = n; best = h; if (n >= a.length) break; }
        }
        return best > 0 ? best : 120;
    }

    /** 顺序配对：返回 [[i, j], ...]（同 site/metro/engine.js 的 match） */
    private static int[][] matchPairs(int[] a, int[] b, int hop, int tol) {
        IntList out = new IntList();
        int i = 0, j = 0;
        while (i < a.length && j < b.length) {
            int d = b[j] - a[i] - hop;
            if (Math.abs(d) <= tol) { out.add(i); out.add(j); i++; j++; }
            else if (d < 0) j++;
            else i++;
        }
        int[] flat = out.toArray();
        int[][] pairs = new int[flat.length / 2][2];
        for (int k = 0; k < pairs.length; k++) { pairs[k][0] = flat[2 * k]; pairs[k][1] = flat[2 * k + 1]; }
        return pairs;
    }

    private static int countMatch(int[] a, int[] b, int hop, int tol) {
        int i = 0, j = 0, c = 0;
        while (i < a.length && j < b.length) {
            int d = b[j] - a[i] - hop;
            if (Math.abs(d) <= tol) { c++; i++; j++; }
            else if (d < 0) j++;
            else i++;
        }
        return c;
    }

    /** 简易 int 动态数组（避免装箱） */
    private static final class IntList {
        private int[] a = new int[16];
        private int n;
        void add(int v) { if (n == a.length) a = Arrays.copyOf(a, n * 2); a[n++] = v; }
        int[] toArray() { return Arrays.copyOf(a, n); }
    }

    /**
     * 沿走廊从 fromIdx 乘到 toIdx 的运行秒数：官网同线站对时间优先；
     * 无官网数据（如跨 3/11 贯通边界的站对）退化为逐段累加，缺失段用 fallbackSec。
     */
    public long elapsedSec(int corridorId, int fromIdx, int toIdx, int fallbackSec) {
        if (fromIdx == toIdx) return 0;
        int[][] mat = pairMatrix.get(corridorId);
        if (mat != null) {
            int v = mat[fromIdx][toIdx];
            if (v > 0) return v;
        }
        return hopSum(corridorId, fromIdx, toIdx, fallbackSec);
    }

    /**
     * 乘车站序遍历中第 k 站相对上车点 boardIdx 的累计运行秒数（各站独立计算，保证单调）：
     * 官网同线站对时间优先，无数据时逐段累加（缺失段用 fallbackSec）。
     */
    public long cumSec(int corridorId, int boardIdx, int k, int fallbackSec) {
        int[][] mat = pairMatrix.get(corridorId);
        if (mat != null) {
            int v = mat[boardIdx][k];
            if (v > 0) return v;
        }
        return hopSum(corridorId, boardIdx, k, fallbackSec);
    }

    /** 相邻一段的运行秒数：官网同线相邻优先，缺失用 fallbackSec */
    private long hopSec(int corridorId, int fromIdx, int toIdx, int fallbackSec) {
        int[][] mat = pairMatrix.get(corridorId);
        if (mat != null) {
            int v = mat[fromIdx][toIdx];
            if (v > 0) return v;
        }
        return fallbackSec;
    }

    /** 逐段累加 fromIdx -> toIdx（含 3/11 贯通边界跨官方线路的情形） */
    private long hopSum(int corridorId, int fromIdx, int toIdx, int fallbackSec) {
        int step = toIdx > fromIdx ? 1 : -1;
        long total = 0;
        for (int i = fromIdx; i != toIdx; i += step)
            total += hopSec(corridorId, i, i + step, fallbackSec);
        return total;
    }

    /** 某走廊某站某星期某方向的发车时刻（秒，升序）；无数据返回空数组 */
    public int[] table(int corridorId, int idx, int weekday, int dir) {
        int[][] t = tables.get(corridorId + "|" + idx + "|" + weekday);
        return t == null ? new int[0] : t[dir];
    }

    public int stopIndex(int corridorId, int gid) {
        List<Integer> stops = corridors.get(corridorId).stopGids();
        for (int i = 0; i < stops.size(); i++) if (stops.get(i) == gid) return i;
        return -1;
    }

    public Integer gid(String stationName) {
        return gidOfName.get(stationName.trim());
    }

    public List<String> suggest(String input) {
        String q = input.trim();
        List<String> out = new ArrayList<>();
        for (String name : gidOfName.keySet()) {
            if (name.contains(q) || q.contains(name) || commonPrefix(name, q) >= 2) out.add(name);
        }
        return out;
    }

    private static int commonPrefix(String a, String b) {
        int n = Math.min(a.length(), b.length());
        for (int i = 0; i < n; i++) if (a.charAt(i) != b.charAt(i)) return i;
        return n;
    }
}
