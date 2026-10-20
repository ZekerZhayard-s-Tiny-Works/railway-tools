#!/usr/bin/env bash
# 构建：编译到 temp/classes。需要已设置 JAVA_HOME（指向 JDK 17+）。
set -e
cd "$(dirname "$0")"

if [ -z "$JAVA_HOME" ]; then
  echo "错误: 未设置 JAVA_HOME。请安装 JDK 17+ 并设置 JAVA_HOME 指向其根目录。" >&2
  exit 1
fi
if [ ! -x "$JAVA_HOME/bin/javac" ] && [ ! -x "$JAVA_HOME/bin/javac.exe" ]; then
  echo "错误: JAVA_HOME 下未找到 javac: $JAVA_HOME" >&2
  exit 1
fi

mkdir -p temp/classes
"$JAVA_HOME/bin/javac" -encoding UTF-8 -d temp/classes src/szmetro/*.java
echo "构建完成 -> temp/classes"
