# BUILD-NOTES —— 手搓鸿蒙 HAP 构建链

> 目标：不用 hvigor / DevEco Studio，用公开 SDK 里的工具把 `harmonyos/` 编成**签名 HAP**。
> 记录时间：2026-10-07，SDK：`D:\ohos\sdk`（`apiVersion 26` / `platformVersion 26.0.0` / Beta）。

---

## 0. 结论（第一优先）

**拿到了签名 HAP，`verify-app` 通过。**

```
D:\dsj-open\harmonyos\entry-default-signed.hap
大小 133716 字节（≈ 130 KB）
verify-app → "verify: Verify success / verify-app success"
```

`entry-default-signed.hap` 内部结构（stage 模型标准）：

```
ets/modules.abc                     90540   ← ArkTS 字节码（合并后的）
.pages.info                            16   ← 打包器按 main_pages 生成
module.json                          1639   ← restool 注入了资源 ID
resources.index                       841
resources/base/media/app_icon.png    2560
resources/base/profile/main_pages.json 56
```

一条命令复现：在 `harmonyos/` 下 `bash build.sh`（Windows 用 Git Bash）。

---

## 1. 每一层实际用的命令（原样，可复制）

变量约定（`build.sh` 顶部）：
```
SDK=D:/ohos/sdk
ETSL=$SDK/ets/ets/build-tools/ets-loader
ES2ABC=$ETSL/bin/ark/build-win/bin/es2abc.exe
REST=$SDK/tc/toolchains/restool.exe
PACK_JAR=$SDK/tc/toolchains/lib/app_packing_tool.jar
SIGN_JAR=$SDK/tc/toolchains/lib/hap-sign-tool.jar
```

### [0] 预处理：`module.json5` → 无注释的合并 `module.json`
`module.json5` 里带注释，ets-loader/restool 用的是 `JSON.parse`，必须先剥成纯 JSON；
并且要把 `AppScope/app.json5` 的 `app` 段和 `entry` 的 `module` 段合并成一个文件
（编译、`getPackageInfo`、restool、打包都用它）。用 SDK 自带 `json5` 解析：
```
node gen_module_json.js   # JSON5.parse(module.json5) + JSON5.parse(app.json5) → module.json
```

### [1] ets-loader（webpack 后端）：`.ets` → 纯 JS（剥类型 + 转 ArkUI）
ets-loader 目录里同时有 **webpack** 配置和 **rollup** 配置；用的是 **webpack 后端**
（见第 3 节「为什么不用 rollup」）。关键是喂对这几个 env，并让 loader 从 ets-loader
自己的 `node_modules` 解析：

```js
process.env.aceModuleRoot     = '<root>/entry/src/main/ets';   // 注意是 .../ets
process.env.aceModuleBuild    = '<work>/js';
process.env.aceProfilePath    = '<root>/entry/src/main/resources/base/profile';
process.env.aceModuleJsonPath = '<work>/module.json';
process.env.cachePath         = '<work>/cache';
process.env.watchMode         = 'false';
const cfg = require(ETSL + '/webpack.config.js')({ compilerType: 'ark', buildMode: 'debug' }, { mode: 'development' });
cfg.resolveLoader = { modules: [ETSL + '/node_modules', 'node_modules'] };
cfg.context = ETSL;
webpack(cfg, (err, stats) => { ... });
```
结果：4 个入口各出一个纯 JS bundle（`entryability/EntryAbility.js`、`pages/{Index,Setup,WebOverlay}.js`）。

> `aceModuleRoot` 必须指到 **`.../ets`** 这一层：ets-loader 内部对 pages 用
> `projectPath/<page>.ets`、对 ability 用 `resolve(projectPath,'..','./ets/...')`，
> 只有 `.../src/main/ets` 能让两者同时命中。

### [2] es2abc：JS → `ets/modules.abc`
写一个 `filesInfo.txt`（SDL 的官方清单格式，字段用 `;` 分隔）：
```
<js文件绝对路径>;<记录名>;commonjs;<源ets相对路径>;<bundleName>;false;ets
```
例如：
```
D:\...\js\pages\Index.js;entry/ets/pages/Index;commonjs;entry/src/main/ets/pages/Index.ets;io.github.hanzhengdev.phoneaccess;false;ets
```
然后：
```
"D:\ohos\sdk\ets\ets\build-tools\ets-loader\bin\ark\build-win\bin\es2abc.exe" \
  "@<work>\filesInfo.txt" --merge-abc --target-api-version=26 --output "<work>\modules.abc"
```
结果：一个 90 KB 的合并 abc，`ark_disasm` 能反汇编，含记录
`entry.ets.entryability.EntryAbility` / `entry.ets.pages.Index` / `Setup` / `WebOverlay`。

### [3] restool：编资源
**关键坑**：`-i` 要指向「模块根」，即一个**包含 `resources/` 子目录**的目录，
不是 `resources/` 本身（指到 `resources` 会“编译成功”但产出空表 → 报 `$media:app_icon not defined`）。
`-j` 用合并后的 `module.json`。
AppScope 与 entry 的资源要先合到一起（否则 app 级 `$media:app_icon` 解析不到）：
```
restool.exe -i <work>/modroot -j <work>/module.json -o <work>/res \
  -p io.github.hanzhengdev.phoneaccess -r <work>/res/ResourceTable.h -f
```
`<work>/modroot/resources` = entry 的 resources + AppScope 的 media + 合并后的 string.json。
产出：`resources.index`、`module.json`（带 `iconId`/`labelId` 等资源 ID）、`resources/`。

### [4] 组装 HAP 目录
```
stage/module.json          ← restool 产出的带资源 ID 的 module.json
stage/ets/modules.abc      ← [2] 的产物
stage/resources.index
stage/resources/base/...   ← restool 拷出的 media/profile 等
```

### [5] app_packing_tool：打包
```
java -jar app_packing_tool.jar --mode hap \
  --json-path      stage/module.json \
  --ets-path       stage/ets \
  --resources-path stage/resources \
  --index-path     stage/resources.index \
  --out-path       <work>/entry-default-unsigned.hap \
  --force true
```

### [6] hap-sign-tool：签名（两段）
口令 `123456`（`OpenHarmony.p12` 是随 SDK 公开分发的社区材料，非机密）。

6a. 从社区库导出中间 CA / 根 CA，拼应用证书链（`keytool` 来自 JDK）：
```
keytool -exportcert -rfc -alias "openharmony application ca"      -keystore OpenHarmony.p12 -storepass 123456 -file c-sub.pem
keytool -exportcert -rfc -alias "openharmony application root ca" -keystore OpenHarmony.p12 -storepass 123456 -file c-root.pem
# 链 = 模板里的发行叶子证书 + c-sub + c-root
```
6b. 生成 profile（把 `bundle-name` 改成自己的），签 profile：
```
java -jar hap-sign-tool.jar sign-profile -mode localSign \
  -keyAlias "openharmony application profile release" -keyPwd 123456 \
  -profileCertFile OpenHarmonyProfileRelease.pem \
  -inFile profile-release.json -signAlg SHA256withECDSA \
  -keystoreFile OpenHarmony.p12 -keystorePwd 123456 \
  -outFile profile-release.p7b
```
6c. 签 hap：
```
java -jar hap-sign-tool.jar sign-app -mode localSign \
  -keyAlias "openharmony application release" -keyPwd 123456 \
  -appCertFile app-release-chain.pem \
  -profileFile profile-release.p7b \
  -inFile entry-default-unsigned.hap -signAlg SHA256withECDSA \
  -keystoreFile OpenHarmony.p12 -keystorePwd 123456 \
  -outFile entry-default-signed.hap
```

### [7] verify-app
```
java -jar hap-sign-tool.jar verify-app \
  -inFile entry-default-signed.hap \
  -outCertChain verify-cert.cer -outProfile verify-profile.p7b
# → "verify: Verify success / verify-app success"
```

---

## 2. 踩到的坑（症状 → 根因 → 解法）

1. **`abilityAccessCtrl.PermissionRequestResult` 不存在**
   （`ArkTS:ERROR NativeOps.ets:226 Namespace 'abilityAccessCtrl' has no exported member`）
   → `@ohos.abilityAccessCtrl` 里 `PermissionRequestResult` 是**具名导出**，不是 `abilityAccessCtrl` 命名空间的成员。改为从 `@kit.AbilityKit` 具名 import。

2. **restool 报 `module 'distro' expected object`**
   → API 26 的 module.json schema 把 `deliveryWithInstall`/`installationFree` 挪进了 `module.distro`，且 `distro` 必填（`deliveryWithInstall`/`moduleName`/`moduleType`）。源码 module.json5 还是老写法。

3. **restool 报 `$media:app_icon is not defined`，但 resources 目录里明明有该 png**
   → 两个独立原因叠加：① `-i` 指到了 `resources/` 而不是**包含 resources/ 的模块根**，导致资源表根本没扫到（产出空 `ResourceTable.h`）；② app 级 `$media:app_icon` 要 AppScope 的资源一起参与。解法：把 AppScope + entry 资源合成一个模块根，`-i` 指模块根。

4. **webpack 报 `Can't resolve 'ts-loader'`（在 harmonyos 目录下跑时）**
   → webpack 的 **loader** 走 `context` 解析，而配置里只对普通 import 设了 `resolve.modules`。把 `cfg.context`/`cfg.resolveLoader` 指回 ets-loader 目录。

5. **es2abc 报 `Invalid character [filesInfo.txt:1:4]`**
   → 清单文件是用 `@` 前缀传给 es2abc 的；漏了 `@` 就被当成一个 JS 源文件解析。

6. **清单里混进了 `.temp.js`**
   → 不设 `cachePath` 时，ets-loader 的 `GenAbcPlugin` 把中间产物 `.temp.js`/`.abc` 写进 buildPath。解法：设 `process.env.cachePath` 把这些挪走，并在生成清单时排除 `.temp.`。

7. **restool 输出文件名有时是 `config.json`，有时是 `module.json`**
   → 跟 `-j` 传入文件的名字有关。解法：两个名字都探测一下，谁在复制谁。

8. **`keytool` 不在 PATH**
   → 只装了 JRE 的 `javapath` 里没有 keytool；JDK 在 `C:\Program Files\Java\jdk-24`。build.sh 里从 `java -XshowSettings:properties` 的 `java.home` 反推 keytool。

9. **`sign-app` 报 `Profile cert must a cert chain`，随后 `verify certificate chain failed`**
   → `-appCertFile` 必须给**证书链**（叶子+中间+根），而不是一张叶子证书；而且 `OpenHarmony.p12` 里 alias 的证书是**自签的**（Owner==Issuer），链验不过。解法：链的叶子用 **profile 模板里那张由 “OpenHarmony Application CA” 签发的发行证书**，再接 `openharmony application ca` + `openharmony application root ca`。

10. **SDK 自带的 `rollup.config.js` 本身是语法错误**（重要，见下节）。

---

## 3. 为什么没用 rollup / hvigor（走过的弯路，如实记录）

`ets-loader` 的现代编译路径是 **rollup**（`rollup.config.js` + `lib/fast_build/**`），
hvigor 就是用它。但在本机独立跑它连撞四关：

1. **`rollup.config.js` 语法非法**：第 84 行把 spread 直接当三元运算的分支
   （`cond ? ...a : ...b`），任何 JS 引擎都不认。
   `node --check rollup.config.js` → `SyntaxError: Unexpected token '...'`。
   说明这份配置根本不是拿来独立执行的（hvigor 里有另外的装配）。
2. **依赖 `this.share`**：所有 fast_build 插件都读 `this.share.projectConfig` 等，
   但 SDK 里**没有任何代码给插件 context 注入 `share`** —— 那是 hvigor 运行时提供的。
   自写垫片后能过，但接着撞第 3 关。
3. **`projectConfig.buildMode` / `projectRootPath` / `meta.belongProjectPath` 等只由 hvigor 的
   `aceBuildJson` 提供**，缺一个就崩（`toLowerCase of undefined`、
   `genTemporaryPath → toUnixPath(undefined)`）。
4. **`@ohos.*` 系统模块的 external 化 / needCompleteSourcesMap 等也依赖 hvigor 上下文**，
   最后 rollup 试图把 `@ohos.router.d.ts` 当模块加载而失败。

结论：要让 rollup 路径独立跑，等于要复刻半个 hvigor 的装配层，性价比太低。
**webpack 后端虽然旧（jsbundle），但它的依赖（webpack / ts-loader / babel 等）
都随 ets-loader 一起发，版本自洽、能独立跑**，所以就走了 webpack。
（`rollup.config.js` 的语法错误已单独记录，建议反馈上游。）

---

## 4. 没解决 / 未验证的地方（最重要，别当已经完工）

1. **只求「编出签名 HAP」，没求「编得好」**：现在的 `modules.abc` 是把 4 个
   **webpack 整包 bundle** 各自作为一条记录合并出来的。每条记录里各自内联了依赖，
   **记录之间可能重复**（webpack 的 splitChunks 在本配置下没生效）。功能上大概率能跑，
   但不是 hvigor 那种「每个源文件一条记录 + 统一 ohmurl」的形态。

2. **记录名是否被运行时认，未验证**：清单里记录名用的是 `entry/ets/pages/Index` 这种形式，
   而鸿蒙运行时真实寻址用的是 `@bundle:<bundleName>/<moduleName>/ets/...` 的 ohmurl。
   没上真机/模拟器，**无法确认页面与 ability 能否被正确加载**。`ark_disasm` 里显示成
   `entry.ets.pages.Index`（点号），也侧面说明记录名可能被规范化过。

3. **没验证过安装/运行**：全程只到 `verify-app`。没连鸿蒙设备，没跑起来。

4. **`compatibleSdkVersion` 没对齐**：工程 `build-profile.json5` 写的是 `5.0.0(12)`，
   而本机 SDK 是 API 26。因为没走 hvigor，这个字段没参与编译；`es2abc` 里手动传的是
   `--target-api-version=26`。真要上真机，得把工程配置改成实际 SDK 版本。

5. **`app.minAPIVersion/targetAPIVersion`**：源码 `AppScope/app.json5` 没有这两项，
   打包器原来会警告；build.sh 在**构建期合并的 JSON 里**补了 `26`，源码没动。

6. **后台保活 / 长时任务 / 定位 / 相机等运行时行为**：源码里本来就有大量
   `// ⚠️ 待验证`，本次编译不涉及，仍全部未验证。

---

## 5. 改了 `harmonyos/` 里的哪些文件（改前 → 改后 → 为什么）

> 只改了「为了编过必须改」的两处，其余源码一字未动；功能没有删。

1. `entry/src/main/ets/bridge/NativeOps.ets`
   - 改前：`import { common, Want, abilityAccessCtrl, Permissions } from '@kit.AbilityKit';`
           且 `const result: abilityAccessCtrl.PermissionRequestResult = ...`
   - 改后：import 里加 `PermissionRequestResult`，类型写成 `PermissionRequestResult`
   - 为什么：`@ohos.abilityAccessCtrl.d.ts` 把 `PermissionRequestResult` 作为**具名导出**
     （`export type PermissionRequestResult = _PermissionRequestResult;`），它不是
     `abilityAccessCtrl` 命名空间的成员；编译报 `no exported member`。纯类型写法修正，行为不变。

2. `entry/src/main/module.json5`
   - 改前：`module` 下直接写 `"deliveryWithInstall": true, "installationFree": false,`
   - 改后：改成 `module.distro = { deliveryWithInstall, installationFree, moduleName:"entry", moduleType:"entry" }`
   - 为什么：API 26 的 module.json schema 要求 `distro` 对象（且必填），restool 直接报
     `The value type of node 'distro' does not match. Expected type: object`。字段搬家，语义不变。

3. 新增 `harmonyos/build.sh`（本链）与 `harmonyos/BUILD-NOTES.md`（本文）。
   构建产物 `entry-default-signed.hap` 也在 `harmonyos/` 下。

---

## 6. 环境要求 / 可直接复制的运行方式

- OS：Windows + **Git Bash**（`C:\Program Files\Git\bin\bash.exe`）
- `node`（本次 v24.14.0）、`java`（本次 JDK 24，另需 `keytool`）
- SDK：`D:\ohos\sdk`（可用 `OHOS_SDK=` 覆盖）
- 无需 `npm install`：第 1 层用到的 webpack 全家桶都在 `ets-loader/node_modules` 里。

```bash
cd /d/dsj-open/harmonyos
bash build.sh
# 产物：/d/dsj-open/harmonyos/entry-default-signed.hap
```

可选环境变量：`OHOS_SDK`、`WORK`（临时目录，默认 `./build`）、`OHOS_KEYSTORE_PASS`。
