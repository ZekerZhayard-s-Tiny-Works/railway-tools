package szmetro;

import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.List;
import java.util.regex.Pattern;

public final class Main {
    private static final Pattern TIME = Pattern.compile("(\\d{1,2}):(\\d{2})(?::(\\d{2}))?");

    public static void main(String[] args) {
        System.setOut(new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8));
        try {
            run(args);
        } catch (CliError e) {
            System.out.println("错误: " + e.getMessage());
            System.exit(2);
        } catch (Exception e) {
            System.out.println("出错: " + e);
            e.printStackTrace(System.out);
            System.exit(1);
        }
    }

    private static final class CliError extends RuntimeException {
        CliError(String msg) { super(msg); }
    }

    private static final class Opts {
        String mode = "route";
        String from, to;
        Integer departSec, arriveSec;
        Integer weekday;
        double runMin = 2.0, transferMin = 5.0;
        boolean refresh, allWeekdays;
        Path cacheDir = Path.of("temp", "cache");
    }

    private static void run(String[] args) throws Exception {
        Opts o = new Opts();
        for (int i = 0; i < args.length; i++) {
            String a = args[i];
            switch (a) {
                case "route", "crawl", "stations" -> o.mode = a;
                case "--from" -> o.from = need(args, ++i, a);
                case "--to" -> o.to = need(args, ++i, a);
                case "--depart" -> o.departSec = parseTime(need(args, ++i, a));
                case "--arrive" -> o.arriveSec = parseTime(need(args, ++i, a));
                case "--weekday" -> {
                    int wd = Integer.parseInt(need(args, ++i, a));
                    if (wd < 1 || wd > 7) throw new CliError("--weekday 取值 1..7（1=周一）");
                    o.weekday = wd;
                }
                case "--run-min" -> {
                    double v = Double.parseDouble(need(args, ++i, a));
                    if (v <= 0 || v > 30) throw new CliError("--run-min 应在 (0, 30] 之间");
                    o.runMin = v;
                }
                case "--transfer-min" -> {
                    double v = Double.parseDouble(need(args, ++i, a));
                    if (v < 0 || v > 60) throw new CliError("--transfer-min 应在 [0, 60] 之间");
                    o.transferMin = v;
                }
                case "--refresh" -> o.refresh = true;
                case "--all-weekdays" -> o.allWeekdays = true;
                case "--cache-dir" -> o.cacheDir = Path.of(need(args, ++i, a));
                case "--help", "-h" -> { printHelp(); return; }
                default -> throw new CliError("未知参数: " + a + "（--help 查看用法）");
            }
        }

        int weekday = o.weekday != null ? o.weekday : LocalDate.now().getDayOfWeek().getValue();
        Crawler crawler = new Crawler(o.cacheDir);
        Files.createDirectories(o.cacheDir);

        switch (o.mode) {
            case "crawl" -> {
                crawler.ensureStations(o.refresh);
                System.out.println("抓取官网站间运行时长...");
                crawler.ensureOfficialTimes(o.refresh);
                List<Integer> cids = crawler.readCorridorIds();
                int[] wds = o.allWeekdays ? new int[]{1, 2, 3, 4, 5, 6, 7} : new int[]{weekday};
                for (int wd : wds) {
                    System.out.println("== 抓取 星期" + "一二三四五六日".charAt(wd - 1) + " ==");
                    for (int cid : cids) {
                        int holes = crawler.crawlTimetables(cid, wd, o.refresh);
                        System.out.println("走廊 " + cid + "（" + cid + "号线）：完成" +
                                (holes > 0 ? "，缺口 " + holes + " 站" : ""));
                    }
                }
                System.out.println("缓存目录: " + o.cacheDir.toAbsolutePath());
            }
            case "stations" -> {
                crawler.ensureStations(o.refresh);
                Network net = Network.load(o.cacheDir);
                for (Network.Corridor c : net.corridors.values()) {
                    System.out.printf("%s（%d 站，方向: %s / %s）%n",
                            c.displayName(), c.stopNames().size(), c.d0Label(), c.d1Label());
                    System.out.println("  " + String.join(" — ", c.stopNames()));
                }
            }
            case "route" -> doRoute(o, crawler, weekday);
        }
    }

    private static void doRoute(Opts o, Crawler crawler, int weekday) throws Exception {
        if (o.from == null || o.to == null) throw new CliError("route 需要 --from 与 --to");
        if ((o.departSec == null) == (o.arriveSec == null))
            throw new CliError("必须且只能指定 --depart HH:MM 或 --arrive HH:MM 之一");

        crawler.ensureStations(o.refresh);
        crawler.ensureOfficialTimes(o.refresh);
        Network net = Network.load(o.cacheDir);
        for (int cid : net.corridors.keySet())
            crawler.crawlTimetables(cid, weekday, o.refresh);
        net = Network.load(o.cacheDir); // 载入新缓存的时刻表

        Integer from = net.gid(o.from), to = net.gid(o.to);
        if (from == null) throw new CliError("未找到车站「" + o.from + "」" + suggest(net, o.from));
        if (to == null) throw new CliError("未找到车站「" + o.to + "」" + suggest(net, o.to));

        Router router = new Router(net, weekday, (int) Math.round(o.runMin * 60), (int) Math.round(o.transferMin * 60));
        Router.Plan plan = o.departSec != null
                ? router.routeDepart(from, to, o.departSec)
                : router.routeArrive(from, to, o.arriveSec);

        String wdName = "周" + "一二三四五六日".charAt(weekday - 1);
        System.out.println("＝" + "＝".repeat(28));
        if (o.departSec != null) {
            System.out.printf("查询: %s → %s（%s %s 后出发，站间 %.1f 分钟 / 换乘 %.0f 分钟）%n",
                    o.from, o.to, wdName, fmt(o.departSec), o.runMin, o.transferMin);
        } else {
            System.out.printf("查询: %s → %s（%s %s 前到达，站间 %.1f 分钟 / 换乘 %.0f 分钟）%n",
                    o.from, o.to, wdName, fmt(o.arriveSec), o.runMin, o.transferMin);
        }
        System.out.println("（时刻表: " + Crawler.BASE + " ；站间运行与换乘时间为估计参数，");
        System.out.println("  多条可行经由时按 时间 → 换乘候车余量合计最长 → 换乘次数最少 取舍，结果仅供参考）");

        if (plan == null) {
            if (o.departSec != null) {
                System.out.println("结果: 当日无可达路线（相关车站/方向当日无列车服务，或换乘链断裂）");
            } else {
                System.out.println("结果: 当日无法在 " + fmt(o.arriveSec) + " 前到达");
            }
            return;
        }

        System.out.println("＝" + "＝".repeat(28));
        if (o.departSec != null) {
            System.out.printf("最早到达: %s（%s 到站台，候车 %d 分钟，全程约 %d 分钟）%n",
                    fmt(plan.arriveSec), fmt(plan.startSec), (plan.boardSec - plan.startSec) / 60,
                    (plan.arriveSec - plan.startSec) / 60);
        } else {
            System.out.printf("最晚出发: %s 从「%s」上车（全程约 %d 分钟，%s 到达，不晚于 %s）%n",
                    fmt(plan.boardSec), o.from, (plan.arriveSec - plan.boardSec) / 60,
                    fmt(plan.arriveSec), fmt(o.arriveSec));
        }
        System.out.println("－" + "－".repeat(28));

        int legNo = 0;
        int firstLegDone = 0;
        int stopCount = 0;
        for (Object row : plan.rows) {
            if (row instanceof Router.Transfer tr) {
                System.out.printf("  ◇ %s 换乘（约 %.0f 分钟，%s 走到站台）%n",
                        net.nameOfGid.get(tr.gid()), o.transferMin, fmt(tr.platformSec()));
            } else if (row instanceof Router.Leg leg) {
                legNo++;
                Network.Corridor c = net.corridors.get(leg.corridorId);
                String toward = leg.dir == 0 ? c.d0Label() : c.d1Label();
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < leg.stopGids.size(); i++) {
                    if (i > 0) sb.append(" → ");
                    sb.append(net.nameOfGid.get(leg.stopGids.get(i)));
                    if (i > 0) sb.append(' ').append(fmt(leg.stopArriveSec.get(i - 1)));
                }
                System.out.printf("  %d. 乘%s（往%s）%s %s 上车%n  %s%n",
                        legNo, c.displayName(), toward, fmt(leg.boardSec),
                        net.nameOfGid.get(leg.stopGids.get(0)), sb);
                stopCount += leg.stopGids.size() - 1;
            }
        }
        System.out.println("－" + "－".repeat(28));
        System.out.printf("经由 %d 站 / 换乘 %d 次 / 换乘候车合计 %d 分钟%n",
                stopCount, plan.transferCount(), plan.transferWaitSec((int) Math.round(o.transferMin * 60)) / 60);
    }

    private static String suggest(Network net, String input) {
        List<String> s = net.suggest(input);
        return s.isEmpty() ? "" : "，相近车站: " + String.join("、", s.stream().limit(8).toList());
    }

    private static String need(String[] args, int i, String opt) {
        if (i >= args.length) throw new CliError(opt + " 缺少取值");
        return args[i];
    }

    private static int parseTime(String s) {
        var m = TIME.matcher(s.trim());
        if (!m.matches()) throw new CliError("时间格式应为 HH:MM 或 HH:MM:SS: " + s);
        int h = Integer.parseInt(m.group(1)), min = Integer.parseInt(m.group(2));
        int sec = m.group(3) != null ? Integer.parseInt(m.group(3)) : 0;
        if (h > 23 || min > 59 || sec > 59) throw new CliError("时间超出范围: " + s);
        return h * 3600 + min * 60 + sec;
    }

    static String fmt(int sec) {
        int day = sec / 86400;
        int rem = sec % 86400;
        String t = String.format("%02d:%02d", rem / 3600, rem % 3600 / 60);
        if (rem % 60 != 0) t += String.format(":%02d", rem % 60);
        return day > 0 ? "次日+" + day + " " + t : t;
    }

    private static void printHelp() {
        System.out.println("""
                苏州地铁时刻表查询（数据源: http://106.14.198.252:8512）

                用法（先构建: javac -encoding UTF-8 -d temp/classes src/szmetro/*.java）:
                  java -cp temp/classes szmetro.Main crawl  [--all-weekdays] [--refresh]
                  java -cp temp/classes szmetro.Main stations
                  java -cp temp/classes szmetro.Main route --from 木渎 --to 桑田岛 --depart 08:30 [--weekday 1]
                  java -cp temp/classes szmetro.Main route --from 木渎 --to 桑田岛 --arrive 09:30

                选项:
                  --from 站名          出发车站（须与 stations 列出的名称一致）
                  --to 站名            到达车站
                  --depart HH:MM      此时刻出发，求最早到达
                  --arrive HH:MM      此时刻前到达，求最晚出发
                  --weekday 1..7      星期（1=周一，缺省=今天）
                  --run-min 数        站间运行分钟数（缺省 2，取自相邻站时刻表偏移众数）
                  --transfer-min 数   同名站跨线换乘分钟数（缺省 5）
                  --refresh           强制重新抓取缓存
                  --all-weekdays      crawl 模式抓取周一至周日全部时刻表
                  --cache-dir 目录    缓存目录（缺省 temp/cache，所有临时文件均在 ./temp 下）
                """);
    }
}
