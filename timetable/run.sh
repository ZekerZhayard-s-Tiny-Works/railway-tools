#!/usr/bin/env bash
# 运行入口：./run.sh route --from 木渎 --to 桑田岛 --depart 08:30
# 需要已设置 JAVA_HOME（指向 JDK 17+），并先执行 ./build.sh。
set -e
cd "$(dirname "$0")"

if [ -z "$JAVA_HOME" ]; then
  echo "错误: 未设置 JAVA_HOME。请安装 JDK 17+ 并设置 JAVA_HOME 指向其根目录。" >&2
  exit 1
fi
if [ ! -x "$JAVA_HOME/bin/java" ] && [ ! -x "$JAVA_HOME/bin/java.exe" ]; then
  echo "错误: JAVA_HOME 下未找到 java: $JAVA_HOME" >&2
  exit 1
fi
if [ ! -d temp/classes ]; then
  echo "尚未构建，请先执行 ./build.sh" >&2
  exit 1
fi
exec "$JAVA_HOME/bin/java" -cp temp/classes szmetro.Main "$@"
