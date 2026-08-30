# 打包构建手册（Web 版 / Android App）

> 涵盖两种构建路线：**① Web 版**（本地运行 / 服务器部署，零构建）和 **② Android App 打包**（Capacitor 套壳）
> 适用读者：想自行构建或二次开发的开发者

> ⚠️ **数据与密钥说明（先读）**
> - 题库数据（`tiku.db` / `practice.db` / `materials.db`）与数据采集工具**不在本仓库**（版权考虑）。构建 Android 包前需自备数据；没有数据也可以打"空壳包"，安装后用 App 内的「自定义题库导入」功能添加题目
> - AI 功能需在设置页自行配置 OpenAI 兼容网关（base_url + api_key）
> - Release 签名需**自备 keystore**，仓库不含任何签名文件与密码

---

## 目录

1. [前置依赖](#1-前置依赖)
2. [路线 A：Web 版（本地运行 / 服务器部署）](#2-路线-aweb-版本地运行--服务器部署)
3. [路线 B：Android App（Capacitor 套壳打包）](#3-路线-bandroid-appcapacitor-套壳打包)
   - [B1：题库离线化打包](#b1-阶段-1--题库离线化打包-build-app-assetsmjs)
   - [B2：Skill 打包（可选）](#b2-阶段-2--skill-打包可选build-skill-bundlemjs)
   - [B3：复制资产到 Android 项目](#b3-阶段-3--复制资产到-android-项目)
   - [B4：构建 APK](#b4-阶段-4--构建-apk)
   - [B5：首次构建（Capacitor 初始化）](#b5-首次构建capacitor-初始化)
4. [产物清单](#4-产物清单)
5. [版本号管理](#5-版本号管理)
6. [常见问题](#6-常见问题)

---

## 1. 前置依赖

### 全平台通用
| 依赖 | 版本要求 | 用途 |
|------|----------|------|
| Node.js | ≥ 22.13（否则 `node:sqlite` 不可用） | 后端 + 构建脚本 |
| npm | 随 Node 自带 | 依赖安装 |

### Android App 打包（路线 B 额外需要）
| 依赖 | 版本要求 | 用途 |
|------|----------|------|
| JDK | **17**（必须 17，11 不够，21 有兼容问题） | 编译 Android 代码 |
| Android SDK | API 34（build-tools 34） | 编译 Android 代码 |
| Gradle | 8.2.1（wrapper 自带，无需手动装） | 构建系统 |
| 签名 keystore | 自备（仅 Release 需要；Debug 包自动使用调试签名） | Release 签名 |

### 环境变量（Android SDK）
确保 `ANDROID_HOME` 或 `ANDROID_SDK_ROOT` 已设置，指向 SDK 路径（例如 `C:\Users\你的用户名\AppData\Local\Android\Sdk`）。

---

## 2. 路线 A：Web 版（本地运行 / 服务器部署）

这是最简单的运行方式，**不需要任何构建步骤**，源码即运行。

### 2.1 安装依赖

```bash
npm install
```

唯一的外部依赖是 `sharp`（图片处理），`playwright-core` 是 dev 依赖（测试用，非必需）。

### 2.2 启动服务

```bash
node server.mjs 3000
```

或者双击项目根目录的 `启动.bat`（Windows 专用，自动打开浏览器）。

访问 `http://localhost:3000` 即可。题库文件（`tiku.db` 等）需按上一节的说明自行准备；AI 功能在「AI 设置」页（`/?view=ai`）配置网关后可用。

### 2.3 服务器部署（公网）

详见 `deploy-guide.md`，概要是：

1. 买云服务器（Ubuntu 22.04，2C2G 起）
2. 上传 `server.mjs` + `public/` + `lib/` + `tiku.db` + `materials.db` + `ai-config.db`
3. 装 Node.js 22+，运行 `node server.mjs 3000`
4. 用 pm2 做进程守护，Caddy 做反向代理 + HTTPS
5. 防火墙只开放 22/80/443

---

## 3. 路线 B：Android App（Capacitor 套壳打包）

### 整体流程概览

```
                      ┌──────────────────┐
                      │   tiku.db        │
                      │   practice.db    │
                      │   materials.db   │  ← 自备数据
                      └──────┬───────────┘
                             │
                    ┌────────▼───────────┐
                    │  build-app-assets   │  ← 阶段 1
                    │  .mjs              │
                    └────────┬───────────┘
                             │
                    ┌────────▼───────────┐
                    │  app-assets/       │  tiku_app.db + images.db
                    │  (public/ 下)      │  + 压缩包 + report.json
                    └────────┬───────────┘
                             │
                    ┌────────▼───────────┐
                    │  build-skill-      │  ← 阶段 2（可选）
                    │  bundle.mjs        │
                    └────────┬───────────┘
                             │
                    ┌────────▼───────────┐
                    │  复制到 Android    │  ← 阶段 3
                    │  assets/ 目录      │
                    └────────┬───────────┘
                             │
                    ┌────────▼───────────┐
                    │  gradlew assemble  │  ← 阶段 4
                    │  Debug / Release   │
                    └────────┬───────────┘
                             │
                    ┌────────▼───────────┐
                    │  app-*.apk         │  ← 最终产物
                    └────────────────────┘
```

---

### B1：阶段 1 — 题库离线化打包（`build-app-assets.mjs`）

**用途**：把三个数据库（tiku.db / practice.db / materials.db）精简为 App 可用的离线包。

**输入**（只读，不会被修改；**需自备**）：
- `tiku.db` — 题库主库（papers / questions）
- `practice.db` — 辅助表（章节树、题组）
- `materials.db` — 申论材料分块

**输出**（写入 `app-assets/` 目录）：
- `tiku_app.db` — 精简列 + 辅助表合并后的只读 SQLite
- `tiku_app.db.gz` — gzip 压缩包（首启解压用）
- `images.db` — 公式图（img_key → blob）
- `images.db.gz`
- `report.json` — 体积/行数/验证结果

**运行命令**：

```bash
# 基础打包（下载所有公式图）
node build-app-assets.mjs

# 指定输出目录（默认 app-assets/）
node build-app-assets.mjs app-assets

# 跳过公式图下载（已有 images.db 时加快重跑；注意：输出目录必须是第一个参数）
node build-app-assets.mjs app-assets --skip-download

# 限制公式图下载数量（调试用）
node build-app-assets.mjs --max-downloads=50
```

**注意事项**：
- 公式图从题源 CDN 按需下载，并发 20，失败自动重试 2 轮；断点续传，失败记录到 `download-fail.log`
- 输出目录默认在项目根目录 `app-assets/`，但**Capacitor 项目实际读取的是 `public/app-assets/`**，所以打包后还要手动复制（见阶段 3）
- 打包后会自动验证关键查询（随机出题、单题查询、章节树、题组、材料），结果写入 `report.json`

**耗时参考**：
- 公式图全量下载（~1900 张）：约 2-5 分钟（视网络）
- 数据库构建 + 验证：约 10-30 秒

---

### B2：阶段 2 — Skill 打包（可选，`build-skill-bundle.mjs`）

**用途**：把 AI 智能体（skill）的 prompt 打包为 JSON 文件，供离线模式下的 App 自动注入（无需网络加载 skill 文件）。

**运行命令**：

```bash
# 打包全部已配置 skill
node build-skill-bundle.mjs

# 打包指定 skill
node build-skill-bundle.mjs gongkao-huasheng13
```

**输出**：`public/app-assets/skill-<name>.json`

---

### B3：阶段 3 — 复制资产到 Android 项目

Capacitor 在构建 APK 时，会把 `webDir`（即 `public/`）复制到 Android assets 中。但 `public/app-assets/` 下的文件（尤其是 `tiku_app.db`，体积可达数百 MB）很大，最好**手动直接放进 assets**，避免构建时重复拷贝。

**手动复制命令**：

```bash
# 确保目标目录存在
mkdir -p app/android/app/src/main/assets/public/app-assets

# 复制构建产物（注意：.gz 压缩包不需要，Android aapt2 会自动解压 .gz 文件并去掉扩展名）
cp public/app-assets/tiku_app.db     app/android/app/src/main/assets/public/app-assets/
cp public/app-assets/images.db       app/android/app/src/main/assets/public/app-assets/
cp public/app-assets/skill-*.json    app/android/app/src/main/assets/public/app-assets/ 2>/dev/null
```

**关键细节**（来自 `NativeDbBridge.java`）：
- 运行时从 `assets/public/app-assets/tiku_app.db` 路径读取
- 首次启动流式复制到应用私有目录（`context.getFilesDir()/db/`），此后跳过
- `images.db` 也走同样的路径
- 这样做的好处是题库不进入 WebView JS 堆，首启内存显著降低

**注意**：`build-app-assets.mjs` 默认输出到 `app-assets/`（项目根目录），但 `local-bootstrap.js` 里查找的是 `./app-assets/` 和 `../app-assets/` 两个路径。如果直接从 `public/app-assets/` 读取，确保文件在那里。

---

### B4：阶段 4 — 构建 APK

#### Debug 构建（推荐第三方构建者使用，无需 keystore）

```bash
cd app/android
./gradlew assembleDebug        # Windows 用 gradlew.bat assembleDebug
```

产物：`app/android/app/build/outputs/apk/debug/app-debug.apk`（自动使用调试签名，可直接安装到手机）

#### Release 构建（正式分发，需要自备签名）

```bash
cd app/android
./gradlew assembleRelease
```

产物：`app/android/app/build/outputs/apk/release/app-release.apk`

**签名说明**（`app/android/app/build.gradle` 中自动探测）：
- 构建时若 `app/android/kaogong-release.keystore` 存在，会自动读取同目录 `keystore-pass.txt`（纯文本存密码）作为签名密码
- **自备签名**：用 keytool 生成自己的 keystore 放到上述位置即可，例如：
  ```bash
  keytool -genkeypair -v -keystore app/android/kaogong-release.keystore -alias 你的别名 -keyalg RSA -keysize 2048 -validity 10000
  ```
  （别名需与 build.gradle 中一致，或自行修改 build.gradle）
- 未放置 keystore 时，Release 产物为**未签名包**，需自行签名后才能安装

**Windows 上的注意**：
- 用 `gradlew.bat` 而不是 `./gradlew`
- 可能需要以管理员身份运行（如果 Android SDK 路径有权限问题）
- 如果构建报 "Could not find com.android.tools.build:gradle:8.2.1"，检查网络或 Gradle 缓存

---

### B5：首次构建（Capacitor 初始化）

如果是**全新环境**（从未构建过 Android 项目），需要先初始化 Capacitor：

```bash
# 1. 安装 Capacitor CLI 和核心库
cd app
npm install

# 2. 初始化 Android 平台（如果 app/android/ 还不完整）
npx cap add android

# 3. 同步 Web 资产到 Android
npx cap copy
```

当前仓库 `app/android/` 已经初始化完毕，`capacitor.settings.gradle`、`capacitor-cordova-android-plugins/` 都已就位，一般不需要重新初始化。只有以下情况需要重新跑 `npx cap copy`：
- `public/` 下的前端文件（index.html / app.js / style.css）有重大更新
- 新增了 Capacitor 插件

---

## 4. 产物清单

### 构建中间产物

| 文件 | 路径 | 大小 | 说明 |
|------|------|------|------|
| tiku_app.db | `app-assets/` 或 `public/app-assets/` | 数百 MB（取决于题库） | 精简题库（只读 SQLite） |
| tiku_app.db.gz | `app-assets/` | 约为原库 1/4 | gzip 压缩包（首启解压用） |
| images.db | `app-assets/` 或 `public/app-assets/` | ~1.5MB | 公式图库 |
| images.db.gz | `app-assets/` | ~0.8MB | 压缩版 |
| report.json | `app-assets/` | ~1KB | 构建报告 |
| skill-*.json | `public/app-assets/` | ~50-280KB | skill 打包 |

### 最终产物

| 文件 | 说明 |
|------|------|
| `app-debug.apk` | 调试版（自动调试签名，可直接安装，logcat 有调试输出） |
| `app-release.apk` | 签名版（需自备 keystore；未放置时为未签名包） |

---

## 5. 版本号管理

版本号在 `app/android/app/build.gradle` 中定义：

```groovy
defaultConfig {
    versionCode 40          // 每次递增，商店用
    versionName "1.38"      // 展示给用户的版本号
}
```

### 版本号递增规则
- `versionCode`：整数，**每次发布递增 +1**（应用商店强制要求递增；侧载覆盖安装同样要求不低于已装版本）
- `versionName`：语义化版本（`主版本.次版本`），用户可见

构建前记得更新这两个值。

---

## 6. 常见问题

### Q1：构建报错 "Could not find com.android.tools.build:gradle:8.2.1"

**原因**：Gradle 缓存中没有这个版本，或网络问题无法下载。

**解决**：
```bash
# 检查网络代理
# 或者手动下载 Gradle 8.2.1 到 C:\Users\用户名\.gradle\wrapper\dists\
# 或者换用本地已有的 Gradle 版本（修改 build.gradle）
```

### Q2：构建报错 "No toolchains found in the NDK"

**原因**：项目用到了 C++ 原生代码，但 NDK 未安装。

**解决**：在 Android Studio 的 SDK Manager 中安装 NDK，或者在 `app/build.gradle` 中配置 `ndkVersion`。

### Q3：打包后 App 白屏 / 题库加载失败

**排查步骤**：
1. 检查 `app/android/app/src/main/assets/public/app-assets/tiku_app.db` 是否存在（空壳包属正常现象，用 App 内「自定义题库导入」加题）
2. 检查 `local-bootstrap.js` 中 `firstExisting` 的路径（`./app-assets/` vs `../app-assets/`）
3. 用 `adb logcat` 查看 WebView 控制台输出：`adb logcat -s Capacitor:V Chrome:V`
4. 在 `MainActivity.onCreate()` 中已开启 `setWebContentsDebuggingEnabled(true)`，可以用 `chrome://inspect` 远程调试

### Q4：公式图不显示

**原因**：`images.db` 缺失或没有正确复制到 assets。

**解决**：重新跑 `node build-app-assets.mjs` 下载公式图，然后复制到 Android assets。

### Q5：想更新 App 但保留用户数据

**直接覆盖安装**同名签名的 APK 即可，做题记录（错题本/收藏/统计）在应用私有目录，卸载才删除。覆盖安装不影响。注意：覆盖安装要求新包签名与已装版本一致，且 versionCode 不低于已装版本。

### Q6：最快打包流程（从零开始）

```bash
# 1. 准备数据（tiku.db / practice.db / materials.db 放到项目根目录）
# 2. 构建题库离线包
node build-app-assets.mjs

# 3. 复制到 public/app-assets（如果 build-app-assets 输出到根目录 app-assets/）
cp -r app-assets/* public/app-assets/

# 4. 打包 skill
node build-skill-bundle.mjs

# 5. 复制到 Android assets
cp public/app-assets/tiku_app.db  app/android/app/src/main/assets/public/app-assets/
cp public/app-assets/images.db    app/android/app/src/main/assets/public/app-assets/
cp public/app-assets/skill-*.json app/android/app/src/main/assets/public/app-assets/

# 6. 构建 APK（第三方推荐 Debug 包，免签名）
cd app/android && ./gradlew assembleDebug
```

---

## 附录：项目构建相关文件索引

| 文件 | 用途 |
|------|------|
| `server.mjs` | 后端服务（Web 版运行入口） |
| `build-app-assets.mjs` | 阶段 1：题库离线化打包 |
| `build-skill-bundle.mjs` | 阶段 2：Skill 打包 |
| `public/local-bootstrap.js` | App 本地模式启动器（加载题库、初始化 API/AI） |
| `public/sqljs-engine.js` | sql.js 引擎（浏览器/WebView 运行 SQLite） |
| `app/android/app/.../NativeDbBridge.java` | 原生 SQLite 桥（替代 sql.js，性能更好） |
| `app/android/app/.../MainActivity.java` | Android 主 Activity（注入 NativeDB 桥） |
| `app/android/app/build.gradle` | Android 构建配置（版本号、签名探测） |
| `app/capacitor.config.json` | Capacitor 配置（webDir、appId） |
| `启动.bat` | Windows 本地启动脚本 |
| `deploy-guide.md` | 公网部署指南 |
| `手机安装使用说明.md` | 给用户的安装说明 |
