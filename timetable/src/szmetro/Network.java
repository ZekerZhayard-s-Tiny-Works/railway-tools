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
     *   - 相邻站按「无越行」顺序配对，hop 取官网相邻时间，配不上再用逐时扫描找最佳；
     *   - 配对率过低（<80%）视为运营分界，不跨段串联（6 号线南斜步两段小交路即靠此判定）；
     *   - 未配上的车视为到前方最近站终到，到达时刻 = 末次发车 + hop。
     */
    private WeekRuns buildRuns(int weekday) {
        final int TOL = 60;
        final double MIN_RATE = 0.8;
        WeekRuns wr = new WeekRuns();
        for (var e : corridors.entrySet()) {
            int cid = e.getKey();
            List<Integer> gids = e.getValue().stopGids();
            List<String> names = e.getValue().stopNames();
            int N = gids.size();
            int[][] mat = pairMatrix.get(cid);
            for (int dir = 0; dir <= 1; dir++) {
                int[] order = new int[N];
                for (int p = 0; p < N; p++) order[p] = dir == 0 ? p : N - 1 - p;
                int[][] deps = new int[N][];
                for (int p = 0; p < N; p++) deps[p] = table(cid, order[p], weekday, dir);
                int[] hop = new int[N - 1];
                for (int p = 0; p < N - 1; p++)
                    hop[p] = pickHop(deps[p], deps[p + 1], mat[order[p]][order[p + 1]], TOL);

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
                // 跳站补链：本站有车、下一站无，但下下站时刻吻合（大站快车）
                for (int p = 0; p + 2 < N; p++) {
                    if (boundary[p] || boundary[p + 1]) continue;
                    for (int i = 0; i < deps[p].length; i++) {
                        if (next[p][i] >= 0) continue;
                        int expect = deps[p][i] + hop[p] + hop[p + 1];
                        for (int j = 0; j < deps[p + 2].length; j++) {
                            if (prev[p + 2][j] >= 0) continue;
                            if (Math.abs(deps[p + 2][j] - expect) <= TOL) {
                                next[p][i] = j;
                                nextPos[p][i] = p + 2;
                                prev[p + 2][j] = i;
                                break;
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
                // 终到时刻：末次发车 + 至下一站的 hop（终点站/小交路终到站均不记到达时刻）
                List<Run> finished = new ArrayList<>(runs.size());
                for (Run run : runs) {
                    int lastIdx = run.idx[run.size() - 1];
                    int p = dir == 0 ? lastIdx : N - 1 - lastIdx;
                    if (p >= N - 1) { finished.add(run); continue; }
                    int[] ni = Arrays.copyOf(run.idx, run.size() + 1);
                    int[] ns = Arrays.copyOf(run.sec, run.size() + 1);
                    ni[run.size()] = order[p + 1];
                    ns[run.size()] = run.sec[run.size() - 1] + hop[p];
                    finished.add(new Run(ni, ns));
                }
                runs = finished;

                wr.runs.put(cid + "|" + dir, runs);
                for (Run run : runs) {
                    for (int k = 0; k < run.size() - 1; k++) {  // 末站是到达，不能上车
                        String key = cid + "|" + dir + "|" + run.idx[k];
                        wr.boardAt.computeIfAbsent(key, x -> new ArrayList<>())
                                .add(new Boarding(run.sec[k], k, run));
                    }
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
