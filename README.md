# 铁路小工具（纯静态站点）

两个在浏览器里本地运行的车次/换乘查询工具，无需后端、无第三方脚本：

- **`metro/` 苏州地铁路由查询** —— 给定出发车站与出发（或到达）时刻，用时间相关 Dijkstra 求时间最短的乘车方案与换乘点。
- **`transfer/` 全国铁路中转换乘查询** —— 在全国铁路车次中搜索换乘方案，支持按出发或到达时刻查询，并可用车站坐标把邻近车站作为接驳段。

首页 `index.html` 是两个工具的入口。整个目录就是一个可直接发布到 GitHub Pages 的静态站点。

## 目录结构

```
index.html  style.css  suggest.js        首页与共用样式、站名补全
metro/
  index.html  app.js                     页面与交互
  engine.js                              Network / Router（由 timetable 的 Java 代码移植）
  render.js                              文本输出渲染（与 Java 命令行版逐字一致）
  data/network.json                      走廊、车站、官网站对时间
  data/tt_w1..w7.json                    各星期逐站发车时刻表
transfer/
  index.html  app.js
  engine.js                              搜索/换乘引擎（由 LulutongTransfer 的 Java 代码移植）
  data/s.i t.i t.rule ver.txt T*.dat     路路通数据包中引擎实际需要的文件
  data/sl.json osm_stations.tsv          车站坐标（邻站接驳用）
timetable/                               苏州地铁抓取程序（Java 源码，供定时任务编译运行）
tools/
  build-metro-data.mjs                   由 timetable 的抓取缓存生成 metro/data
  update-lltskb-data.mjs                 由 down.lltskb.com 更新 transfer/data
  verify-metro.mjs verify-transfer.mjs   与 Java 版逐字符对拍
.github/workflows/update-metro.yml       每周自动抓取、校验并部署
```

## 数据来源与刷新

站点数据是**构建时的快照**：浏览器受同源与混合内容限制，无法在运行时抓取这两个 HTTP 数据源。

**苏州地铁**（源站 `http://106.14.198.252:8512`）：由 `.github/workflows/update-metro.yml` 每周自动执行，无需本机参与。仓库内的 `timetable/` 是抓取程序源码，工作流会依次：

1. 编译并抓取 7 个星期的时刻表与官网站对时间（约 20~40 分钟，取决于 runner 到源站的网络）；
2. `node tools/build-metro-data.mjs --min-stops 264 --min-departures 80000` 重建 `metro/data`，站次或班次低于阈值即判为抓取异常、不写文件；
3. `node tools/verify-metro.mjs` 与 Java 版对拍，必须 20 通过 0 失败；
4. 有变化才提交 `metro/data`，最后把站点作为 Pages 工件部署。

定时为 UTC `0 0 * * 1`，即北京时间每周一 08:00；也可在 Actions 页面手动 `Run workflow` 触发。GitHub 的定时任务可能延迟数分钟到数十分钟。

本地手动执行同样的流程：

```bash
cd timetable && ./build.sh && ./run.sh crawl --all-weekdays --refresh
cd .. && node tools/build-metro-data.mjs --min-stops 264 --min-departures 80000
node tools/verify-metro.mjs
```

**全国铁路**（源 `http://down.lltskb.com`）：数据包含全部车次，只挑引擎需要的 24 个文件（约 1.4 MB）：

```bash
node tools/update-lltskb-data.mjs transfer/data
```

两个脚本都会先比对远端/本地版本，必要时才重新生成。更新后提交即可，Pages 会自动重新发布。

## 与 Java 版的一致性

`metro/engine.js`、`transfer/engine.js` 分别是 `timetable/src/szmetro/*.java` 与
`LulutongTransfer/src/main/java/lulutong/*.java` 的移植，数据格式与算法（时间相关 Dijkstra、
多标签最短路、开行规则位掩码、邻站接驳）保持一致。对拍脚本会用同一批查询同时跑 Java 版和 JS 版，
逐字符比较结果文本与日志：

```bash
node tools/verify-metro.mjs         # 需要 <timetable>/temp/classes 已编译
node tools/verify-transfer.mjs      # 需要 LulutongTransfer 的 jar 与已更新的数据目录
```

## 部署

GitHub Pages，源为 **GitHub Actions**：`update-metro.yml` 抓取完成后把站点打包成工件并部署；平时的代码改动推送到 `main` 后，可在 Actions 里手动运行该工作流来发布。`.nojekyll` 已就位，站点不需要额外构建。

## 数据版权与免责

- 苏州地铁时刻表、站间运行时间分别抓取自第三方时刻表网站与苏州地铁官网；全国铁路时刻表来自路路通数据包；`osm_stations.tsv` 来自 OpenStreetMap（ODbL，© OpenStreetMap contributors）；`sl.json` 为 CRTransfer 数据。
- 时刻表与票价随时可能调整，站点数据会过期；所有结果仅供参考，实际请以车站公告为准。
