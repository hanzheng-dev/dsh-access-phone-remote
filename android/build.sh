#!/usr/bin/env bash
# 手工构建「dsh-access-phone-remote」APK —— 不需要 Gradle / Android Studio
# 用法: bash build.sh
#
# ══════════════════════════════════════════════════════════════
# 开始前你需要准备（Windows + Git Bash）：
#   1. JDK（17+）—— 提供 javac / java / keytool
#      （keytool 只在**首次构建**生成签名密钥时用；缺了用 KEYTOOL=/路径/keytool 指定）
#   2. Node.js    —— 只用它跑 make-icons.js 生成图标
#   3. 7-Zip      —— 把 classes.dex 塞进 APK
#      （确保 7z 在 PATH，或用 SEVENZ=/路径/7z.exe 指定）
#   4. Android SDK（下载地址见下）：
#        · build-tools（内含 aapt2.exe / zipalign.exe / lib\d8.jar / lib\apksigner.jar）
#        · platform（android.jar，建议 API 33）
#      官网下载：
#        https://developer.android.com/tools/releases/build-tools
#        https://developer.android.com/tools/releases/platforms
#      或用 sdkmanager：sdkmanager "build-tools;34.0.0" "platforms;android-33"
#   5. 可选：adb（在 PATH 且连着手机时，构建完自动安装）
#
# 环境变量：
#   ANDROID_BT   【必填】build-tools 目录（内含 aapt2.exe/zipalign.exe/lib/d8.jar）
#   ANDROID_JAR  【必填】android.jar 完整路径
#   ROOT         工程根目录（默认 = 本脚本所在目录）
#   SEVENZ / KEYTOOL / ADB  对应工具的可执行文件（默认从 PATH 找）
# 例：
#   ANDROID_BT=/c/sdk/build-tools/34.0.0 \
#   ANDROID_JAR=/c/sdk/platforms/android-33/android.jar \
#   bash build.sh
# ══════════════════════════════════════════════════════════════
set -e

ROOT="${ROOT:-$(cd "$(dirname "$0")" && pwd)}"
BT="${ANDROID_BT:-}"
AJAR="${ANDROID_JAR:-}"
if [ -z "$BT" ] || [ -z "$AJAR" ]; then
  echo "请先设置 Android SDK 路径："
  echo "  export ANDROID_BT=/path/to/build-tools/34.0.0"
  echo "  export ANDROID_JAR=/path/to/platforms/android-33/android.jar"
  echo "（或直接编辑本脚本顶部的默认值）"
  exit 1
fi
SEVENZ="${SEVENZ:-7z}"
KEYTOOL="${KEYTOOL:-keytool}"
OUT=$ROOT/build
APKNAME=dsh-access-phone-remote.apk

# ---------- 工具链预检（给出看得懂的报错，别让用户对着 No such file 发愣） ----------
if [ ! -e "$BT/aapt2.exe" ]; then
  echo "✗ 找不到 aapt2：$BT"
  echo "  请用 ANDROID_BT 指向 build-tools 目录（见本文件头部说明）"
  exit 1
fi
if [ ! -e "$AJAR" ]; then
  echo "✗ 找不到 android.jar：$AJAR"
  echo "  请用 ANDROID_JAR 指定（见本文件头部说明）"
  exit 1
fi
command -v "$SEVENZ" >/dev/null 2>&1 || { echo "✗ 找不到 7z —— 装 7-Zip 并加入 PATH，或 SEVENZ=/路径/7z.exe 指定"; exit 1; }
# keytool 只在**首次构建**（要生成签名密钥）时用得到 ⇒ 已有 keystore 就不强制要求
if [ ! -f "$ROOT/dsjiang.keystore" ]; then
  command -v "$KEYTOOL" >/dev/null 2>&1 || { echo "✗ 找不到 keytool —— 首次构建要生成签名密钥；装 JDK 并加入 PATH，或 KEYTOOL=/路径/keytool 指定"; exit 1; }
fi

# MSYS 路径 -> Windows 路径（任意盘符：/d/xx -> D:/xx）
w() { echo "$1" | sed -E 's|^/([a-z])/|\U\1:/|'; }

rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex" "$OUT/stage"
cd "$ROOT"

echo "[0/8] 生成图标"
node make-icons.js > /dev/null

echo "[1/8] aapt2 compile"
"$BT/aapt2.exe" compile --dir "$(w $ROOT/res)" -o "$(w $OUT/res.zip)"
echo "      res.zip $(stat -c%s "$OUT/res.zip") bytes"

echo "[2/8] aapt2 link"
"$BT/aapt2.exe" link \
  -o "$(w $OUT/base.apk)" \
  -I "$(w $AJAR)" \
  --manifest "$(w $ROOT/AndroidManifest.xml)" \
  "$(w $OUT/res.zip)" \
  --min-sdk-version 24 \
  --target-sdk-version 33
echo "      base.apk $(stat -c%s "$OUT/base.apk") bytes"

echo "[3/8] javac"
javac -encoding UTF-8 --release 8 -nowarn \
  -classpath "$(w $AJAR)" \
  -d "$(w $OUT/classes)" \
  "$(w $ROOT)"/src/io/github/hanzhengdev/phoneaccess/*.java

echo "[4/8] d8 -> classes.dex"
find "$OUT/classes" -name '*.class' | while read -r f; do w "$f"; done > "$OUT/classlist.txt"
java -cp "$(w $BT/lib/d8.jar)" com.android.tools.r8.D8 \
  --lib "$(w $AJAR)" --min-api 24 \
  --output "$(w $OUT/dex)" \
  @"$(w $OUT/classlist.txt)"
ls -l "$OUT/dex/"

echo "[5/8] 塞入 classes.dex"
cp "$OUT/dex/classes.dex" "$OUT/stage/classes.dex"
( cd "$OUT/stage" && "$SEVENZ" a -tzip -mx=9 "$(w $OUT/base.apk)" classes.dex > /dev/null )
echo "      $(stat -c%s "$OUT/base.apk") bytes"

echo "[6/8] zipalign"
"$BT/zipalign.exe" -p -f 4 "$(w $OUT/base.apk)" "$(w $OUT/aligned.apk)"

echo "[7/8] 签名密钥"
if [ ! -f "$ROOT/dsjiang.keystore" ]; then
  "$KEYTOOL" -genkeypair -keystore "$(w $ROOT/dsjiang.keystore)" -alias dsjiang \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass dsjiang123 -keypass dsjiang123 \
    -dname "CN=dsjiang, OU=hz, O=hz, L=Shanghai, S=Shanghai, C=CN" 2>&1 | tail -2
  echo "      ⚠ 首次构建已生成签名密钥 dsjiang.keystore（自用够；发正式版请换成自己的）"
fi

echo "[8/8] apksigner"
java -jar "$(w $BT/lib/apksigner.jar)" sign \
  --ks "$(w $ROOT/dsjiang.keystore)" \
  --ks-pass pass:dsjiang123 --key-pass pass:dsjiang123 \
  --out "$(w $ROOT/$APKNAME)" \
  "$(w $OUT/aligned.apk)"

echo
echo "==================== 完成 ===================="
ls -l "$ROOT/$APKNAME"
java -jar "$(w $BT/lib/apksigner.jar)" verify --print-certs "$(w $ROOT/$APKNAME)" 2>&1 | head -4

# ⭐ 2026-09-18 op 加：装完自动 force-stop + 重启 app。
#   病根：装新版不会杀掉已在跑的进程 ⇒ 手里还是旧代码，白测一场（01:01 踩过）。
#   ⚠️ 没连设备/没装 adb 就跳过，不影响构建。
echo
echo "[9/9] 安装并重启 app（没连设备则跳过）"
ADB="${ADB:-adb}"
if command -v "$ADB" >/dev/null 2>&1 && "$ADB" get-state >/dev/null 2>&1; then
  "$ADB" install -r "$(w $ROOT/$APKNAME)" \
    && "$ADB" shell am force-stop io.github.hanzhengdev.phoneaccess \
    && "$ADB" shell am start -n io.github.hanzhengdev.phoneaccess/.MainActivity \
    || echo "      ⚠ 安装/重启失败，请手动处理"
else
  echo "      没连 adb 设备（或没装 adb），跳过（APK 已生成；手动装完务必 force-stop 再开）"
fi
