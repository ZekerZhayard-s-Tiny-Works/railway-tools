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
tools/
  build-metro-data.mjs                   由 timetable 的抓取缓存生成 metro/data
  update-lltskb-data.mjs                 由 down.lltskb.com 更新 transfer/data
  verify-metro.mjs verify-transfer.mjs   与 Java 版逐字符对拍
```

## 数据来源与刷新

站点数据是**构建时的快照**：浏览器受同源与混合内容限制，无法在运行时抓取这两个 HTTP 数据源。

**苏州地铁**（源站 `http://106.14.198.252:8512`）：先在 timetable 项目里抓取缓存（`./run.sh crawl --all-weekdays`），再重新生成站点数据：

```bash
node tools/build-metro-data.mjs <timetable>/temp/cache metro/data
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

GitHub Pages：仓库根目录即为站点根目录（`main` 分支 `/` ），`.nojekyll` 已就位，不需要构建步骤。

## 数据版权与免责

- 苏州地铁时刻表、站间运行时间分别抓取自第三方时刻表网站与苏州地铁官网；全国铁路时刻表来自路路通数据包；`osm_stations.tsv` 来自 OpenStreetMap（ODbL，© OpenStreetMap contributors）；`sl.json` 为 CRTransfer 数据。
- 时刻表与票价随时可能调整，站点数据会过期；所有结果仅供参考，实际请以车站公告为准。
