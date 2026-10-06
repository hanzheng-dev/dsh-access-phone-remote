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

echo "[1/7] ets-loader: 把 .ets 编成 JS（剥类型 + 转 ArkUI）"
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
const out = process.env.WORK_DIR;
fs.writeFileSync(path.join(out, 'module.json'), JSON.stringify(merged, null, 2));
console.log('  module.json 已生成（app+module 合并）');
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

echo "[2/7] es2abc: JS → ets/modules.abc"
cat > "$WORK/make_abc_list.js" <<'JS'
const fs = require('fs'), path = require('path');
const WORK = process.env.WORK_DIR, BUNDLE = process.env.BUNDLE;
const jsDir = path.join(WORK, 'js');
const lines = [];
(function walk(d){ for (const f of fs.readdirSync(d)) {
  const p = path.join(d, f);
  if (fs.statSync(p).isDirectory()) { walk(p); continue; }
  if (!p.endsWith('.js') || p.includes('.temp.')) continue;     // 排除 .temp.js 等中间产物
  const rel = path.relative(jsDir, p).replace(/\\/g, '/').replace(/\.js$/, ''); // entryability/EntryAbility
  const src = 'entry/src/main/ets/' + rel + '.ets';
  const record = 'entry/ets/' + rel;                                            // 记录名
  lines.push([p, record, 'commonjs', src, BUNDLE, 'false', 'ets'].join(';'));
} })(jsDir);
fs.writeFileSync(path.join(WORK, 'filesInfo.txt'), lines.join('\n') + '\n');
console.log('  filesInfo.txt: ' + lines.length + ' 条');
JS
WORK_DIR="$WORK" BUNDLE="$BUNDLE" node "$WORK/make_abc_list.js"
"$ES2ABC" "@$(w "$WORK/filesInfo.txt")" --merge-abc --target-api-version=26 --output "$(w "$WORK/modules.abc")"
ls -l "$WORK/modules.abc"

echo "[3/7] restool: 编资源（AppScope + entry 合并进一个 module 根）"
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

echo "[4/7] 组装 HAP 目录结构"
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

echo "[5/7] app_packing_tool: 打包 → entry-default-unsigned.hap"
java -jar "$(w "$PACK_JAR")" --mode hap \
  --json-path "$(w "$S/module.json")" \
  --ets-path "$(w "$S/ets")" \
  --resources-path "$(w "$S/resources")" \
  --index-path "$(w "$S/resources.index")" \
  --out-path "$(w "$WORK/entry-default-unsigned.hap")" \
  --force true

echo "[6/7] hap-sign-tool: 签名"
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

echo "[7/7] verify-app: 验证签名"
java -jar "$(w "$SIGN_JAR")" verify-app \
  -inFile "$(w "$ROOT/$HAPNAME")" \
  -outCertChain "$(w "$WORK/verify-cert.cer")" \
  -outProfile "$(w "$WORK/verify-profile.p7b")"

echo
echo "==================== 完成 ===================="
ls -l "$ROOT/$HAPNAME"
echo "产物: $ROOT/$HAPNAME"
