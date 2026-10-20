package szmetro;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 从苏州地铁网站抓取并解析数据，缓存到本地文本文件（均在 ./temp 下）。
 *
 * 网站行为（实测）：
 *  - /station 服务端渲染 9 条菜单线路（v-line 1..8,11）及每条线路的车站顺序。
 *  - /scheduling 需要全部 Cookie：line=菜单线路号、station=百分号编码且属于该线路的站名、
 *    weekday=1..7（1=周一）、direction=0/1；缺站或站不属于该线路时 302 回首页。
 *    返回"小时→分钟"茎叶图：该站该方向按星期区分的发车时刻表（每站独立）。
 *    线路首尾相接（3/11 号线贯通运营）时方向标签跨线（花桥/苏州新区火车站），
 *    个别站数据缺失时服务端自动回退到同站其他线路并改标题。
 */
public final class Crawler {
    /** 可用 -Dszmetro.base=... 覆盖（排查用） */
    public static final String BASE = System.getProperty("szmetro.base", "http://106.14.198.252:8512");

    private static final Pattern MENU_LINE = Pattern.compile("<li[^>]*v-line=\"(\\d+)\">(\\d+号线)");
    private static final Pattern BLOCK = Pattern.compile("<div class=\"right-con[^\"]*\">\\s*<ul>([\\s\\S]*?)</ul>");
    private static final Pattern H4 = Pattern.compile("<h4>([^<]*)</h4>");
    private static final Pattern TAB_ROW =
            Pattern.compile("<div class=\"tab-item\">\\s*<div class=\"tab-item-left\">(\\d+)</div>\\s*"
                    + "<div class=\"tab-item-right\"[^>]*>([\\s\\S]*?)</div>");
    private static final Pattern TOKEN = Pattern.compile("\\d{1,2}");
    private static final Pattern DIR_LABEL = Pattern.compile("v-direction=\"(\\d)\"[^>]*>\\s*([^<]+?)\\s*<");
    private static final Pattern ACTIVE_DIR = Pattern.compile("box-item-active[^\"]*\"\\s*v-direction=\"(\\d)\"");

    private final Path cacheDir;

    public Crawler(Path cacheDir) {
        this.cacheDir = cacheDir;
    }

    /** 走廊中的一站：归属菜单线路号 + 站名 */
    public record Stop(int menuLine, String name) {}

    /**
     * 抓取 /station 并构建"走廊"：菜单线路依次处理，若线路首站与已有走廊末站相同
     * （贯通运营，如 3 号线末站唯亭 = 11 号线首站），则合并为一条走廊。
     * 写出 corridors.txt（走廊 -> 菜单线路号）与 stations.txt（走廊内有序车站）。
     */
    public void ensureStations(boolean refresh) throws IOException, InterruptedException {
        Path corF = cacheDir.resolve("corridors.txt");
        Path staF = cacheDir.resolve("stations.txt");
        if (!refresh && Files.exists(corF) && Files.exists(staF)) return;

        String html = get(BASE + "/station", null, "station.html");
        List<Integer> menuIds = new ArrayList<>();
        Matcher m = MENU_LINE.matcher(html);
        while (m.find()) menuIds.add(Integer.parseInt(m.group(1)));
        if (menuIds.isEmpty()) throw new IOException("/station 页面未解析到线路菜单");
        List<List<String>> blocks = new ArrayList<>();
        Matcher bm = BLOCK.matcher(html);
        while (bm.find()) {
            List<String> sts = new ArrayList<>();
            Matcher hm = H4.matcher(bm.group(1));
            while (hm.find()) sts.add(hm.group(1).trim());
            blocks.add(sts);
        }
        if (blocks.size() != menuIds.size())
            throw new IOException("线路数(" + menuIds.size() + ")与站点块数(" + blocks.size() + ")不一致");

        List<List<Stop>> corridors = new ArrayList<>();
        List<Set<Integer>> corLines = new ArrayList<>();
        for (int i = 0; i < menuIds.size(); i++) {
            int lineId = menuIds.get(i);
            List<String> sts = blocks.get(i);
            if (sts.isEmpty()) throw new IOException("线路 " + lineId + " 站点为空");
            boolean merged = false;
            for (int c = 0; c < corridors.size() && !merged; c++) {
                List<Stop> cor = corridors.get(c);
                if (cor.get(cor.size() - 1).name().equals(sts.get(0))) {
                    for (String s : sts.subList(1, sts.size())) cor.add(new Stop(lineId, s));
                    corLines.get(c).add(lineId);
                    merged = true;
                } else if (cor.get(0).name().equals(sts.get(sts.size() - 1))) {
                    List<Stop> prep = new ArrayList<>();
                    for (String s : sts.subList(0, sts.size() - 1)) prep.add(new Stop(lineId, s));
                    prep.addAll(cor);
                    corridors.set(c, prep);
                    corLines.get(c).add(lineId);
                    merged = true;
                }
            }
            if (!merged) {
                List<Stop> cor = new ArrayList<>();
                for (String s : sts) cor.add(new Stop(lineId, s));
                corridors.add(cor);
                Set<Integer> lines = new LinkedHashSet<>();
                lines.add(lineId);
                corLines.add(lines);
            }
        }
        for (List<Stop> cor : corridors) {
            Set<String> seen = new LinkedHashSet<>();
            for (Stop s : cor)
                if (!seen.add(s.name()))
                    throw new IOException("走廊内存在重复车站: " + s.name());
        }

        StringBuilder cb = new StringBuilder(), sb = new StringBuilder();
        for (int c = 0; c < corridors.size(); c++) {
            int cid = corridors.get(c).get(0).menuLine();
            cb.append(cid).append('\t').append(corLines.get(c).toString().replaceAll("[\\[\\] ]", "")).append('\n');
            for (int i = 0; i < corridors.get(c).size(); i++)
                sb.append(cid).append('\t').append(i).append('\t')
                        .append(corridors.get(c).get(i).menuLine()).append('\t')
                        .append(corridors.get(c).get(i).name()).append('\n');
        }
        Files.writeString(corF, cb.toString(), StandardCharsets.UTF_8);
        Files.writeString(staF, sb.toString(), StandardCharsets.UTF_8);
    }

    /**
     * 抓取一条走廊在指定星期、两个方向的全站时刻表。
     * 每站先按其归属菜单线路请求，被 302 时回退到同站其他菜单线路。
     * 返回缺口数（两个方向都无数据的站）。
     */
    public int crawlTimetables(int corridorId, int weekday, boolean refresh)
            throws IOException, InterruptedException {
        List<String[]> stops = readCorridorStops(corridorId); // {idx, menuLine, name}
        Map<String, Set<Integer>> nameLines = readNameLines();
        String corridorLabels = null; // 走廊级方向标签，取首个成功站，后续站据此校验数据归属
        int holes = 0;
        for (String[] stop : stops) {
            int idx = Integer.parseInt(stop[0]);
            int menuLine = Integer.parseInt(stop[1]);
            String name = stop[2];
            Path out = cacheDir.resolve("tt_" + corridorId + "_" + idx + "_w" + weekday + ".txt");
            if (!refresh && Files.exists(out)) continue;

            List<Integer> candidates = new ArrayList<>();
            candidates.add(menuLine);
            for (int l : nameLines.getOrDefault(name, Set.of()))
                if (l != menuLine) candidates.add(l);

            int[][] tables = new int[2][];
            String labels = null;
            StringBuilder src = new StringBuilder();
            for (int dir = 0; dir <= 1; dir++) {
                for (int line : candidates) {
                    try {
                        String cookie = "line=" + line + "; station=" + enc(name)
                                + "; weekday=" + weekday + "; direction=" + dir;
                        String html = get(BASE + "/scheduling", cookie,
                                "c" + corridorId + "_i" + idx + "_w" + weekday + "_d" + dir + ".html");
                        Matcher am = ACTIVE_DIR.matcher(html);
                        if (am.find() && Integer.parseInt(am.group(1)) != dir)
                            throw new IOException("页面渲染方向与请求不符"); // 换下一个候选线路
                        String lab = parseLabels(html);
                        if (corridorLabels != null && !corridorLabels.equals(lab))
                            throw new IOException("方向标签与走廊不符，疑似错误回退数据");
                        labels = lab;
                        tables[dir] = parseMinutes(html);
                        if (src.length() > 0) src.append(';');
                        src.append('d').append(dir).append("=L").append(line);
                        break;
                    } catch (IOException e) {
                        tables[dir] = null; // 换下一个候选线路
                    }
                    Thread.sleep(150);
                }
                if (tables[dir] == null) tables[dir] = new int[0];
                Thread.sleep(120);
            }
            if (labels != null && corridorLabels == null) corridorLabels = labels;
            boolean ok = tables[0].length > 0 || tables[1].length > 0;
            if (!ok) holes++;
            StringBuilder body = new StringBuilder();
            body.append("# ok=").append(ok ? 1 : 0);
            if (labels != null) body.append(" labels=").append(labels);
            if (src.length() > 0) body.append(" src=").append(src);
            body.append('\n');
            for (int dir = 0; dir <= 1; dir++) {
                // 按小时聚合输出，保持"小时→分钟"的茎叶结构
                Map<Integer, List<Integer>> byHour = new TreeMap<>();
                for (int sec : tables[dir]) {
                    int hour = sec / 3600, minute = sec % 3600 / 60;
                    byHour.computeIfAbsent(hour, k -> new ArrayList<>()).add(minute);
                }
                for (var e : byHour.entrySet()) {
                    body.append(dir).append('\t').append(e.getKey());
                    for (int minute : e.getValue()) body.append('\t').append(String.format("%02d", minute));
                    body.append('\n');
                }
            }
            Files.writeString(out, body.toString(), StandardCharsets.UTF_8);
        }
        return holes;
    }

    /** 页面里的方向标签，如 "0:花桥|1:苏州新区火车站" */
    private static String parseLabels(String html) {
        String[] lab = new String[2];
        Matcher dm = DIR_LABEL.matcher(html);
        while (dm.find()) {
            int d = Integer.parseInt(dm.group(1));
            if (d == 0 || d == 1) lab[d] = dm.group(2);
        }
        return "0:" + lab[0] + "|1:" + lab[1];
    }

    /** 从激活方向的时刻表解析出发时刻（秒），升序去重 */
    private static int[] parseMinutes(String html) {
        TreeSet<Integer> secs = new TreeSet<>();
        Matcher rm = TAB_ROW.matcher(html);
        while (rm.find()) {
            int hour = Integer.parseInt(rm.group(1));
            if (hour < 0 || hour > 47) continue;
            Matcher tm = TOKEN.matcher(rm.group(2));
            while (tm.find()) {
                int v = Integer.parseInt(tm.group());
                if (v >= 0 && v <= 59) secs.add(hour * 3600 + v * 60);
            }
        }
        return secs.stream().mapToInt(Integer::intValue).toArray();
    }

    private String enc(String name) {
        return URLEncoder.encode(name, StandardCharsets.UTF_8);
    }

    /** stations.txt 中某走廊的全部站：{idx, menuLine, name} */
    public List<String[]> readCorridorStops(int corridorId) throws IOException {
        List<String[]> out = new ArrayList<>();
        for (String ln : Files.readAllLines(cacheDir.resolve("stations.txt"), StandardCharsets.UTF_8)) {
            if (ln.isBlank()) continue;
            String[] p = ln.split("\t", 4);
            if (Integer.parseInt(p[0]) == corridorId)
                out.add(new String[]{p[1], p[2], p[3]});
        }
        out.sort((a, b) -> Integer.compare(Integer.parseInt(a[0]), Integer.parseInt(b[0])));
        return out;
    }

    /** 全部走廊 id */
    public List<Integer> readCorridorIds() throws IOException {
        List<Integer> ids = new ArrayList<>();
        for (String ln : Files.readAllLines(cacheDir.resolve("corridors.txt"), StandardCharsets.UTF_8)) {
            if (ln.isBlank()) continue;
            ids.add(Integer.parseInt(ln.split("\t")[0]));
        }
        return ids;
    }

    /** 站名 -> 所有包含该站的菜单线路（同站数据缺失时的候选回退源） */
    private Map<String, Set<Integer>> readNameLines() throws IOException {
        Map<String, Set<Integer>> map = new TreeMap<>();
        for (String ln : Files.readAllLines(cacheDir.resolve("stations.txt"), StandardCharsets.UTF_8)) {
            if (ln.isBlank()) continue;
            String[] p = ln.split("\t", 4);
            map.computeIfAbsent(p[3], k -> new LinkedHashSet<>()).add(Integer.parseInt(p[2]));
        }
        return map;
    }

    // ---------- 官网（sz-mtr.com）站间运行时长 ----------

    private static final String OFFICIAL_HOST = "https://www.sz-mtr.com";
    private static final Pattern OFF_STATION = Pattern.compile("szmtr\\.stations\\[\"([^\"]+)\"\\] = \\{ name: \"([^\"]*)\"");
    private static final Pattern OFF_LINE_NAME = Pattern.compile("szmtr\\.line\\[(\\d+)\\]\\.name = \"([^\"]*)\"");
    private static final Pattern OFF_LINE_BLOCK = Pattern.compile("szmtr\\.line\\[(\\d+)\\]\\.station = new Array\\(([\\s\\S]*?)\\);");
    private static final Pattern OFF_OBJ = Pattern.compile("\\{[^{}]*\\}");
    private static final Pattern OFF_ID = Pattern.compile("id:\\s*\"([^\"]+)\"");
    private static final Pattern OFF_TYPE = Pattern.compile("type:\\s*\"([^\"]+)\"");
    private static final Pattern TICKET_ID = Pattern.compile("\"id\"\\s*:\\s*\"([^\"]+)\"");
    private static final Pattern TICKET_TIME = Pattern.compile("\"time\"\\s*:\\s*(\\d+)");
    private static final Set<String> OFFICIAL_MAIN_LINES =
            Set.of("1号线", "2号线", "3号线", "4号线", "5号线", "6号线", "7号线", "8号线", "11号线");

    /**
     * 抓取官网站间时间数据并缓存到 official_pairs.txt / official_lines.txt：
     *  1. stationInfo_zh.js：站号->站名（换乘站的键形如 sX_YYYY）；
     *  2. szmtr.js：各线路有序站表（t#### 是作图曲线点，不是车站）；
     *  3. /admin/getTransTickets.do?sid=站号：该站到全网各站的乘车时间（分钟）。
     * 官网跨线时间不准确（用户提示），只采信同一线路车站之间的时分；
     * official_pairs.txt 行 = 线路名\t站A\t站B\tA->B分钟\tB->A分钟（A、B 为线路上任意
     * 两站，按线路序 i<j 取全对；缺数据为空字段）；
     * official_lines.txt 行 = 线路名\t序号\t站名（用于确定站对的方向）。
     */
    public void ensureOfficialTimes(boolean refresh) throws IOException, InterruptedException {
        Path pairF = cacheDir.resolve("official_pairs.txt");
        Path lineF = cacheDir.resolve("official_lines.txt");
        if (!refresh && Files.exists(pairF) && Files.exists(lineF)) return;
        Path tkDir = cacheDir.resolve("official").resolve("tickets");
        Files.createDirectories(tkDir);

        String info = get(OFFICIAL_HOST + "/service/guide/map/javascript/stationInfo_zh.js", null, "official_stationInfo.js");
        String szm = get(OFFICIAL_HOST + "/service/guide/map/javascript/szmtr.js", null, "official_szmtr.js");

        Map<String, String> names = new HashMap<>();
        Matcher m = OFF_STATION.matcher(info);
        while (m.find()) if (!m.group(2).isEmpty()) names.put(m.group(1), m.group(2));
        Map<String, String> lineNames = new HashMap<>();
        m = OFF_LINE_NAME.matcher(info);
        while (m.find()) lineNames.put(m.group(1), m.group(2));

        record OffLine(String name, List<String> stopNames, List<String> bareIds) {}
        List<OffLine> lines = new ArrayList<>();
        m = OFF_LINE_BLOCK.matcher(szm);
        while (m.find()) {
            String lname = lineNames.get(m.group(1));
            if (lname == null || !OFFICIAL_MAIN_LINES.contains(lname)) continue;
            List<String> stopNames = new ArrayList<>(), bareIds = new ArrayList<>();
            Matcher sm = OFF_OBJ.matcher(m.group(2));
            while (sm.find()) {
                String entry = sm.group();
                Matcher im = OFF_ID.matcher(entry);
                if (!im.find()) continue;
                String raw = im.group(1);
                Matcher tm2 = OFF_TYPE.matcher(entry);
                String type = tm2.find() ? tm2.group(1) : "";
                if ("arc".equals(type) || raw.matches("t\\d+.*")) continue;
                String bare = raw.contains("_") ? raw.substring(raw.indexOf('_') + 1) : raw;
                String nm = names.getOrDefault(raw, names.get(bare));
                if (nm == null) continue;
                stopNames.add(nm);
                bareIds.add(bare);
            }
            lines.add(new OffLine(lname, stopNames, bareIds));
        }

        Set<String> allIds = new LinkedHashSet<>();
        for (OffLine l : lines) allIds.addAll(l.bareIds);
        Map<String, Map<String, Integer>> timeTo = new HashMap<>();
        for (String sid : allIds) {
            Path f = tkDir.resolve(sid + ".json");
            if (refresh || !Files.exists(f)) {
                String body;
                try {
                    body = get(OFFICIAL_HOST + "/admin/getTransTickets.do?sid=" + sid, null, null);
                } catch (IOException e) {
                    body = ""; // 个别站接口 302（如未开通站），写空文件避免反复重试
                }
                Files.writeString(f, body, StandardCharsets.UTF_8);
                Thread.sleep(120);
            }
            String body = Files.readString(f, StandardCharsets.UTF_8);
            if (!body.trim().startsWith("[")) continue; // 未开通站等返回 302 页
            Map<String, Integer> to = new HashMap<>();
            Matcher om = OFF_OBJ.matcher(body);
            while (om.find()) {
                Matcher im = TICKET_ID.matcher(om.group());
                Matcher vm = TICKET_TIME.matcher(om.group());
                if (im.find() && vm.find()) to.put(im.group(1), Integer.parseInt(vm.group(1)));
            }
            timeTo.put(sid, to);
        }

        StringBuilder pb = new StringBuilder(), lb = new StringBuilder();
        for (OffLine l : lines) {
            for (int i = 0; i < l.stopNames.size(); i++)
                lb.append(l.name).append('\t').append(i).append('\t').append(l.stopNames.get(i)).append('\n');
            for (int i = 0; i < l.stopNames.size(); i++) {
                for (int j = i + 1; j < l.stopNames.size(); j++) {
                    String a = l.stopNames.get(i), b = l.stopNames.get(j);
                    if (a.equals(b)) continue;
                    Integer ab = timeTo.getOrDefault(l.bareIds.get(i), Map.of()).get(l.bareIds.get(j));
                    Integer ba = timeTo.getOrDefault(l.bareIds.get(j), Map.of()).get(l.bareIds.get(i));
                    if (ab == null && ba == null) continue;
                    pb.append(l.name).append('\t').append(a).append('\t').append(b).append('\t')
                            .append(ab == null ? "" : ab).append('\t').append(ba == null ? "" : ba).append('\n');
                }
            }
        }
        Files.writeString(pairF, pb.toString(), StandardCharsets.UTF_8);
        Files.writeString(lineF, lb.toString(), StandardCharsets.UTF_8);
    }

    private String get(String url, String cookie, String rawName) throws IOException, InterruptedException {
        IOException last = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            try {
                HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url))
                        .timeout(Duration.ofSeconds(20))
                        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
                        .header("Accept", "*/*");
                if (cookie != null) b.header("Cookie", cookie);
                HttpResponse<byte[]> resp = newClient().send(b.build(), HttpResponse.BodyHandlers.ofByteArray());
                if (resp.statusCode() == 200) {
                    String body = new String(resp.body(), StandardCharsets.UTF_8);
                    saveRaw(rawName, body);
                    return body;
                }
                String loc = resp.headers().firstValue("Location").orElse("");
                last = new IOException("HTTP " + resp.statusCode() + " -> " + loc);
                if (resp.statusCode() == 302) break; // Cookie 组合不被接受，重试无意义
            } catch (IOException e) {
                last = e;
                Thread.sleep(500L * (attempt + 1));
            }
        }
        throw new IOException("请求失败: " + url + "，原因: " + last, last);
    }

    private HttpClient newClient() {
        return HttpClient.newBuilder()
                // 站点对 Cookie 头大小写敏感：HTTP/2 默认以小写 "cookie:" 发送会被 302，
                // 固定 HTTP/1.1 保证 "Cookie:" 首字母大写
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    private void saveRaw(String name, String body) {
        if (name == null) return;
        try {
            Path raw = cacheDir.resolve("raw");
            Files.createDirectories(raw);
            Files.writeString(raw.resolve(name), body, StandardCharsets.UTF_8);
        } catch (IOException ignored) {
            // 原始页面仅用于排查，写失败不影响主流程
        }
    }
}
