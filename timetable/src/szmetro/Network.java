package szmetro;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
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
    /** 方向 0 沿走廊站序的行进步长（+1 = 往走廊末站）；方向 1 与之相反 */
    public final Map<Integer, Integer> dir0Step = new HashMap<>();
    /** 走廊 -> 站对运行时间矩阵 [i][j] = 第 i 站乘到第 j 站的官网同线时间（秒），-1 = 无数据 */
    public final Map<Integer, int[][]> pairMatrix = new HashMap<>();

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
            int step;
            if (l0 == null) {
                step = 0; // 该走廊尚无任何时刻表数据
            } else if (l0.equals(names.get(names.size() - 1))) {
                step = +1;
            } else if (l0.equals(names.get(0))) {
                step = -1;
            } else {
                throw new IOException("走廊 " + cid + " 方向标签(" + l0 + "/" + l1
                        + ")与车站端点(" + names.get(0) + "/" + names.get(names.size() - 1) + ")不匹配");
            }
            n.dir0Step.put(cid, step);
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
                for (int i = 0; i < e.getValue().size(); i++) pos.put(e.getValue().get(i), i);
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
                Integer pi = pos.get(p[1]), pj = pos.get(p[2]);
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
            Map<String, CorrLine> corrLines = new HashMap<>(); // 官网线路名 -> (站名 -> 官网线内序号, 与走廊同向?)
            for (int menuLine : e.getValue().menuLineIds()) {
                String lname = menuLine + "号线";
                Map<String, Integer> pos = offPos.get(lname);
                if (pos == null) continue;
                Map<String, Integer> offIdx = new HashMap<>();
                int minCorr = Integer.MAX_VALUE, maxCorr = -1;
                int firstOffIdx = -1, lastOffIdx = -1;
                int n_ = pos.size();
                for (var pe : pos.entrySet()) {
                    int cIdx = names.indexOf(pe.getKey());
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
                        Integer pi = ce.getValue().offIdx().get(names.get(i));
                        Integer pj = ce.getValue().offIdx().get(names.get(j));
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

    /** 方向 dir（0/1）沿走廊站序的行进步长 */
    public int stepOf(int corridorId, int dir) {
        int s = dir0Step.get(corridorId);
        return dir == 0 ? s : -s;
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
