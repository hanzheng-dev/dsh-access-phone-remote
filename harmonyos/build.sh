#!/usr/bin/env bash
# ============================================================================
# 手工构建「dsh-access-phone-remote」HarmonyOS HAP —— 不需要 hvigor / DevEco Studio
# 用法: bash build.sh
#
# 流水线（每一层都是公开 SDK 里的工具，hvigor 只是编排器）：
#   [1] ets-loader(webpack 后端)  把 entry/src/main/ets/**.ets → 纯 JS（剥类型 + 转 ArkUI）
#   [2] es2abc --merge-abc        把 JS → ets/modules.abc（合并成一个字节码文件）
#   [3] restool                   把 resources 编成 resources.index + config.json(带资源 ID 的 module.json)
#   [4] 组装 HAP 目录结构
#   [5] app_packing_tool.jar      打包 → entry-default-unsigned.hap
#   [6] hap-sign-tool.jar         先 sign-profile 出 p7b，再 sign-app 出签名 hap
#   [7] verify-app                验签，打印产物
#
# 环境变量（可覆盖）：
#   OHOS_SDK       鸿蒙 SDK 根目录（默认 D:/ohos/sdk）
#   WORK           临时工作目录（默认 <本目录>/build）
#   OHOS_KEYSTORE_PASS   社区签名库口令（默认 123456，OpenHarmony.p12 是公开材料）
#
# 依赖：node、java(JDK：java/keytool)。SDK 里自带的 node_modules 已足够，无需 npm install。
# ⚠️ 口令不硬编码敏感值 —— OpenHarmony.p12 口令是随 SDK 公开分发的 123456。
# ============================================================================
set -e

ROOT="${ROOT:-$(cd "$(dirname "$0")" && pwd)}"
SDK="${OHOS_SDK:-D:/ohos/sdk}"
ETS="$SDK/ets/ets"
TOOLS="$SDK/tc/toolchains"
ETSL="$ETS/build-tools/ets-loader"
ES2ABC="$ETSL/bin/ark/build-win/bin/es2abc.exe"
REST="$TOOLS/restool.exe"
PACK_JAR="$TOOLS/lib/app_packing_tool.jar"
SIGN_JAR="$TOOLS/lib/hap-sign-tool.jar"
OH_P12="$TOOLS/lib/OpenHarmony.p12"
OH_PROFILE_CERT="$TOOLS/lib/OpenHarmonyProfileRelease.pem"
OH_PROFILE_TPL="$TOOLS/lib/UnsgnedReleasedProfileTemplate.json"
WORK="${WORK:-$ROOT/build}"
PASS="${OHOS_KEYSTORE_PASS:-123456}"

APP_DIR="$ROOT/AppScope"
ENTRY_MAIN="$ROOT/entry/src/main"
BUNDLE="io.github.hanzhengdev.phoneaccess"
HAPNAME="entry-default-signed.hap"

# MSYS/Git Bash 路径 → Windows 路径（给 restool/java/es2abc 这类 exe 用）
w() { cygpath -w "$1" 2>/dev/null || echo "$1"; }

# ---------- 工具链预检 ----------
[ -e "$ES2ABC" ]      || { echo "✗ 找不到 es2abc: $ES2ABC（OHOS_SDK 指对了吗？）"; exit 1; }
[ -e "$REST" ]        || { echo "✗ 找不到 restool: $REST"; exit 1; }
[ -e "$PACK_JAR" ]    || { echo "✗ 找不到 app_packing_tool.jar: $PACK_JAR"; exit 1; }
[ -e "$SIGN_JAR" ]    || { echo "✗ 找不到 hap-sign-tool.jar: $SIGN_JAR"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "✗ 找不到 node"; exit 1; }
command -v java >/dev/null 2>&1 || { echo "✗ 找不到 java（要 JDK）"; exit 1; }

find_keytool() {
  if command -v keytool >/dev/null 2>&1; then command -v keytool; return; fi
  local jh cand
  jh=$(java -XshowSettings:properties -version 2>&1 | awk -F' = ' '/java.home/{print $2; exit}' | tr -d '\r')
  if [ -n "$jh" ]; then
    cand="$(cygpath -u "$jh")/bin/keytool.exe"; [ -x "$cand" ] && { echo "$cand"; return; }
    cand="$(cygpath -u "$jh")/bin/keytool";     [ -x "$cand" ] && { echo "$cand"; return; }
  fi
  echo ""
}
KEYTOOL="$(find_keytool)"

mkdir -p "$WORK/js" "$WORK/res"

echo "[1/8] ets-loader: 把 .ets 编成 JS（剥类型 + 转 ArkUI）"
cat > "$WORK/gen_module_json.js" <<'JS'
const fs = require('fs'), path = require('path');
const SDK = process.env.OHOS_SDK || 'D:/ohos/sdk';
const JSON5 = require(SDK + '/ets/ets/build-tools/ets-loader/node_modules/json5');
const root = process.env.PROJ_ROOT;
const moduleObj = JSON5.parse(fs.readFileSync(path.join(root, 'entry/src/main/module.json5'), 'utf8'));
const appObj = JSON5.parse(fs.readFileSync(path.join(root, 'AppScope/app.json5'), 'utf8'));
const merged = Object.assign({}, appObj, moduleObj);           // app + module 合并
if (merged.app) {                                              // 补上 SDK 版本号（避免打包器警告）
  if (merged.app.minAPIVersion === undefined) merged.app.minAPIVersion = 26;
  if (merged.app.targetAPIVersion === undefined) merged.app.targetAPIVersion = 26;
}
// ★★ 必须显式写 module.compileMode = "esmodule"（2026-10-07 实测，见 RUN-NOTES §3.4）
//    缺了它，ArkTS 引擎 InitializeAppInfo() 读到空 → **不启用 esmodule 加载路径**，
//    退化成 FA 那条路：去找 pages/Setup.abc 而不是 modules.abc，必然失败。
//    module.json5 里没有这个字段是正常的 —— DevEco 工程是从 build-profile.json5 带进去的，
//    手搓链没有那一层，所以在这里补。
if (merged.module) {
  if (merged.module.compileMode === undefined) merged.module.compileMode = 'esmodule';
  if (merged.module.packageName === undefined) merged.module.packageName = merged.module.name;
}
const out = process.env.WORK_DIR;
fs.writeFileSync(path.join(out, 'module.json'), JSON.stringify(merged, null, 2));
console.log('  module.json 已生成（app+module 合并，compileMode=' + merged.module.compileMode + '）');
JS

cat > "$WORK/run_ets_loader.js" <<'JS'
const path = require('path'), fs = require('fs');
const SDK = process.env.OHOS_SDK || 'D:/ohos/sdk';
const ET = SDK + '/ets/ets/build-tools/ets-loader';
const WORK = process.env.WORK_DIR;
const webpack = require(ET + '/node_modules/webpack');
const OUT = path.join(WORK, 'js');

// ets-loader 的 webpack 后端靠这些 env 定位工程（等价 hvigor 传参）
process.env.aceModuleRoot       = path.join(process.env.PROJ_ROOT, 'entry/src/main/ets');
process.env.aceModuleBuild      = OUT;
process.env.aceProfilePath      = path.join(process.env.PROJ_ROOT, 'entry/src/main/resources/base/profile');
process.env.aceModuleJsonPath   = path.join(WORK, 'module.json');   // 无注释的合并 module.json
process.env.cachePath           = path.join(WORK, 'cache');         // 中间产物（.temp.js/.abc）扔这，别污染 js/
process.env.watchMode           = 'false';

const env = { compilerType: 'ark', buildMode: 'debug' };
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const cfg = require(ET + '/webpack.config.js')(env, { mode: 'development' });
cfg.stats = 'errors-warnings';
// loader（ts-loader 等）要从 ets-loader 自己的 node_modules 解析，否则在工程目录下跑会找不到
cfg.resolveLoader = { modules: [ET + '/node_modules', 'node_modules'] };
cfg.context = ET;
webpack(cfg, (err, stats) => {
  if (err) { console.error(err); process.exit(1); }
  if (stats.hasErrors()) { console.error(stats.toString({ errors: true, all: false })); process.exit(2); }
  const n = [];
  (function walk(d){ for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : (p.endsWith('.js') && n.push(p)); } })(OUT);
  console.log('  生成 JS 文件 ' + n.length + ' 个');
  process.exit(n.length > 0 ? 0 : 3);
});
JS

OHOS_SDK="$SDK" PROJ_ROOT="$ROOT" WORK_DIR="$WORK" node "$WORK/gen_module_json.js"
OHOS_SDK="$SDK" PROJ_ROOT="$ROOT" WORK_DIR="$WORK" node "$WORK/run_ets_loader.js"

echo "[2/8] es2abc: JS → ets/modules.abc"
cat > "$WORK/make_abc_list.js" <<'JS'
const fs = require('fs'), path = require('path');
const WORK = process.env.WORK_DIR, BUNDLE = process.env.BUNDLE;
const jsDir = path.join(WORK, 'js');
// 归一化 ohmurl 记录名要用到的两个值，直接从刚生成的 module.json 里取（数据驱动，不写死）
const mj = JSON.parse(fs.readFileSync(path.join(WORK, 'module.json'), 'utf8'));
const MODULE  = mj.module.name;          // "entry"
const VERSION = mj.app.versionName;      // "1.0.0"
const lines = [];
(function walk(d){ for (const f of fs.readdirSync(d)) {
  const p = path.join(d, f);
  if (fs.statSync(p).isDirectory()) { walk(p); continue; }
  if (!p.endsWith('.js') || p.includes('.temp.')) continue;     // 排除 .temp.js 等中间产物
  const rel = path.relative(jsDir, p).replace(/\\/g, '/').replace(/\.js$/, ''); // entryability/EntryAbility
  const src = 'entry/src/main/ets/' + rel + '.ets';
  // ★★ 记录名必须是**归一化 ohmurl**，不能是随便一个路径（2026-10-07 实测，见 RUN-NOTES §3.5）
  //    运行时（libark_jsruntime）拿 `<bundleName>&<模块名>/<模块内路径>&<版本>` 去 modules.abc 里找记录。
  //    正规做法是调 ets-loader/lib/ark_utils.js 的 getNormalizedOhmUrlByFilepath，它内部就是：
  //        pkgInfo.bundleName + '&' + pkgName + '/' + projectFilePath + '&' + pkgInfo.version
  //    它要一整套 projectConfig + pkgContextInfo，这里按同一个公式算等价值。
  //    ⚠️ 第一段是 **bundleName**（应用的包名，不是模块名）—— 这一点是拿运行时的原话校准的：
  //        Throw error: Cannot find module
  //          'io.github.hanzhengdev.phoneaccess&entry/src/main/ets/pages/Setup&1.0.0'
  //        （第一段写成模块名 'entry' 会被拒。别照抄任何"看起来像"的写法，以运行时说的为准。）
  const record = BUNDLE + '&' + MODULE + '/src/main/ets/' + rel + '&' + VERSION;
  // 模块类型必须 esm：写 commonjs 会报 "Input file is not esmodule"
  lines.push([p, record, 'esm', src, BUNDLE, 'false', 'ets'].join(';'));
} })(jsDir);
fs.writeFileSync(path.join(WORK, 'filesInfo.txt'), lines.join('\n') + '\n');
console.log('  filesInfo.txt: ' + lines.length + ' 条，记录名形如 ' +
  BUNDLE + '&' + MODULE + '/src/main/ets/...&' + VERSION);
JS
WORK_DIR="$WORK" BUNDLE="$BUNDLE" node "$WORK/make_abc_list.js"
"$ES2ABC" "@$(w "$WORK/filesInfo.txt")" --merge-abc --target-api-version=26 --output "$(w "$WORK/modules.abc")"
ls -l "$WORK/modules.abc"

echo "[3/8] restool: 编资源（AppScope + entry 合并进一个 module 根）"
cat > "$WORK/combine_res.js" <<'JS'
const fs = require('fs'), path = require('path');
const root = process.env.PROJ_ROOT, WORK = process.env.WORK_DIR;
const ENTRY = path.join(root, 'entry/src/main/resources');
const APP = path.join(root, 'AppScope/resources');
const OUT = path.join(WORK, 'modroot/resources');
function cpDir(src, dst){ if(!fs.existsSync(src)) return; fs.mkdirSync(dst,{recursive:true});
  for (const e of fs.readdirSync(src,{withFileTypes:true})){ const s=path.join(src,e.name),d=path.join(dst,e.name);
    e.isDirectory()?cpDir(s,d):fs.copyFileSync(s,d); } }
cpDir(ENTRY, OUT); cpDir(path.join(APP,'base/media'), path.join(OUT,'base/media'));
const ep=path.join(OUT,'base/element/string.json'), ap=path.join(APP,'base/element/string.json');
const es=JSON.parse(fs.readFileSync(ep,'utf8')), seen=new Set(es.string.map(x=>x.name));
for (const it of JSON.parse(fs.readFileSync(ap,'utf8')).string) if(!seen.has(it.name)) es.string.push(it);
fs.writeFileSync(ep, JSON.stringify(es,null,2));
console.log('  合并资源就绪');
JS
WORK_DIR="$WORK" PROJ_ROOT="$ROOT" node "$WORK/combine_res.js"
"$REST" -i "$(w "$WORK/modroot")" -j "$(w "$WORK/module.json")" -o "$(w "$WORK/res")" -p "$BUNDLE" -r "$(w "$WORK/res/ResourceTable.h")" -f

echo "[4/8] 组装 HAP 目录结构"
S="$WORK/stage"
mkdir -p "$S/ets" "$S/resources"
if [ -f "$WORK/res/module.json" ]; then
  cp "$WORK/res/module.json" "$S/module.json"        # restool 产出（带资源 ID）
else
  cp "$WORK/res/config.json" "$S/module.json"
fi
cp "$WORK/modules.abc"          "$S/ets/modules.abc"
cp "$WORK/res/resources.index"  "$S/resources.index"
cp -r "$WORK/res/resources/."   "$S/resources/"

# pkgContextInfo.json —— 运行时的「包名 → 模块」解析表（2026-10-07 实测，见 RUN-NOTES §3.3）
# 没有它，多包/ohModule 解析链是空的；预览器直接报 loader.json/pkgContextInfo 缺失。
# 打包器用 --pkg-context-path 收它（参数名从 app_packing_tool.jar 的 CommandParser 里挖出来的）。
cat > "$WORK/gen_pkg_context.js" <<'JS'
const fs = require('fs'), path = require('path');
const WORK = process.env.WORK_DIR;
const mj = JSON.parse(fs.readFileSync(path.join(WORK, 'module.json'), 'utf8'));
const mod = mj.module, app = mj.app;
const info = {};
info[mod.name] = {
  packageName:  mod.packageName || mod.name,
  bundleName:   app.bundleName,
  moduleName:   mod.name,
  version:      app.versionName,
  entryAbility: mod.mainElement || 'EntryAbility',
  compileMode:  mod.compileMode || 'esmodule',
  isSO:         false,
  dependencies: {},
};
fs.writeFileSync(path.join(process.env.STAGE_DIR, 'pkgContextInfo.json'), JSON.stringify(info, null, 2));
console.log('  pkgContextInfo.json 已生成（' + mod.name + ' → ' + app.bundleName + '）');
JS
WORK_DIR="$WORK" STAGE_DIR="$S" node "$WORK/gen_pkg_context.js"

echo "[5/8] app_packing_tool: 打包 → entry-default-unsigned.hap"
java -jar "$(w "$PACK_JAR")" --mode hap \
  --json-path "$(w "$S/module.json")" \
  --ets-path "$(w "$S/ets")" \
  --resources-path "$(w "$S/resources")" \
  --index-path "$(w "$S/resources.index")" \
  --pkg-context-path "$(w "$S/pkgContextInfo.json")" \
  --out-path "$(w "$WORK/entry-default-unsigned.hap")" \
  --force true

echo "[6/8] hap-sign-tool: 签名"
# 6a. 从社区库导出中间/根 CA 证书，拼出应用证书链
if [ -n "$KEYTOOL" ]; then
  "$KEYTOOL" -exportcert -rfc -alias "openharmony application ca"      -keystore "$(w "$OH_P12")" -storepass "$PASS" -file "$(w "$WORK/c-sub.pem")"
  "$KEYTOOL" -exportcert -rfc -alias "openharmony application root ca" -keystore "$(w "$OH_P12")" -storepass "$PASS" -file "$(w "$WORK/c-root.pem")"
else
  echo "  ⚠ 没找到 keytool，无法导出 CA 证书链；签名会失败。请确保 JDK 的 keytool 可用。"
fi
# 6b. 生成 profile（改 bundleName）+ 证书链
cat > "$WORK/prep_profile.js" <<'JS'
const fs = require('fs'), path = require('path');
const WORK = process.env.WORK_DIR, SDK = process.env.OHOS_SDK || 'D:/ohos/sdk';
const BUNDLE = process.env.BUNDLE;
const tpl = JSON.parse(fs.readFileSync(SDK + '/tc/toolchains/lib/UnsgnedReleasedProfileTemplate.json', 'utf8'));
// 叶子用模板里那张 CA 签发的发行证书（p12 里 alias 的证书是自签的，链验不过）
const leaf = tpl['bundle-info']['distribution-certificate'];
const sub = fs.readFileSync(path.join(WORK, 'c-sub.pem'), 'utf8');
const root = fs.readFileSync(path.join(WORK, 'c-root.pem'), 'utf8');
fs.writeFileSync(path.join(WORK, 'app-release-chain.pem'), leaf + sub + root);
tpl['bundle-info']['bundle-name'] = BUNDLE;
tpl['bundle-info']['apl'] = 'normal';
tpl['validity'] = { 'not-before': 1594865258, 'not-after': 4102444800 };  // 到 2100，见 BUILD-NOTES
fs.writeFileSync(path.join(WORK, 'profile-release.json'), JSON.stringify(tpl, null, 2));
console.log('  profile + 证书链就绪');
JS
WORK_DIR="$WORK" BUNDLE="$BUNDLE" OHOS_SDK="$SDK" node "$WORK/prep_profile.js"

java -jar "$(w "$SIGN_JAR")" sign-profile -mode localSign \
  -keyAlias "openharmony application profile release" -keyPwd "$PASS" \
  -profileCertFile "$(w "$OH_PROFILE_CERT")" \
  -inFile "$(w "$WORK/profile-release.json")" \
  -signAlg SHA256withECDSA \
  -keystoreFile "$(w "$OH_P12")" -keystorePwd "$PASS" \
  -outFile "$(w "$WORK/profile-release.p7b")"

java -jar "$(w "$SIGN_JAR")" sign-app -mode localSign \
  -keyAlias "openharmony application release" -keyPwd "$PASS" \
  -appCertFile "$(w "$WORK/app-release-chain.pem")" \
  -profileFile "$(w "$WORK/profile-release.p7b")" \
  -inFile "$(w "$WORK/entry-default-unsigned.hap")" \
  -signAlg SHA256withECDSA \
  -keystoreFile "$(w "$OH_P12")" -keystorePwd "$PASS" \
  -outFile "$(w "$ROOT/$HAPNAME")"

echo "[7/8] verify-app: 验证签名"
java -jar "$(w "$SIGN_JAR")" verify-app \
  -inFile "$(w "$ROOT/$HAPNAME")" \
  -outCertChain "$(w "$WORK/verify-cert.cer")" \
  -outProfile "$(w "$WORK/verify-profile.p7b")"

echo "[8/8] preview-smoke: 真的把它跑起来看一眼（verify-app 通过 ≠ 运行时会接受）"
# 为什么必须有这一步（2026-10-07 踩到的）：
#   verify-app 只证明「文件格式合法 + 签名有效」，**完全不证明运行时会加载这份字节码**。
#   实测就是：verify-app 一路 success，Previewer 一跑却报
#     Cannot find module 'io.github.hanzhengdev.phoneaccess&entry/src/main/ets/pages/Setup&1.0.0'
#   —— 手工构建链把 modules.abc 的记录名拼错了。所以构建的最后一道关必须是「真的跑」。
#
# ⚠️ 只验 pages/Setup。**pages/Index 验不了，而且它在预览器里注定是白屏**：
#   Index.ets 第 54 行是字段初始化器 `new webview.WebviewController()`，
#   而 Previewer 里根本没有 ArkWeb 模块（`@kit.ArkWeb` 是 undefined），一构造就抛
#     TypeError: Cannot read property WebviewController of undefined
#   ⇒ 那是**预览器的能力边界**，不是构建缺陷。Index（全屏 Web 壳）只能在真机/模拟器上验。
#   别因为"Index 白屏"去改构建参数，会白折腾。
if [ "${SKIP_SMOKE:-0}" = "1" ]; then
  echo "  ⏭ SKIP_SMOKE=1，已跳过（只在人明确知道自己在放弃什么时才用）"
else
  OHOS_SDK="$SDK" node "$ROOT/tools/preview-smoke.js" "$S" pages/Setup "${SMOKE_SECONDS:-25}" || {
    echo "  ✗ 运行期自检没过。产物**不可信**，别发。"
    echo "    截图在 $S/smoke-frame.jpg，日志在 %TEMP%\\ohos-smoke-*\\previewer.out"
    exit 1
  }
fi

echo
echo "==================== 完成 ===================="
ls -l "$ROOT/$HAPNAME"
echo "产物: $ROOT/$HAPNAME"
