# 手机 App 版开发计划（考公刷题）

> 版本：v2 · 2026-08-11 · 状态：阶段 1-4 已实现并**大改后复验全绿**；剩余阶段 5（Capacitor 打包）待批准
> 目标：把现有 Web 刷题应用打包成**真正的 Android App**（桌面图标、全屏、无浏览器痕迹），题库与个人数据全部在手机本地，**不需要服务器、不需要同一 WiFi、不需要登录**。

---

## 1. 目标与形态

| 项 | 说明 |
|---|---|
| 形态 | Capacitor 套壳的 Android APK，安装后有桌面图标、启动画面、全屏体验 |
| 数据 | `app-assets/tiku_app.db.gz`（36.1MB，含题库+分类索引+材料）作为只读资源打进 App；错题本/收藏/统计存手机 IndexedDB |
| 网络 | **零依赖**：刷题、判分、错题本完全离线可用；仅 AI 解析和未缓存真图形需要联网 |
| 登录 | **去掉**：个人单机版，打开即用，无用户隔离 |
| AI | 设置页自填 key（只存本机），联网直调 OpenAI 兼容接口；断网优雅降级 |
| 与现有版关系 | **同一份前端代码双模式运行**：服务器版（多人、有登录）不受影响；App 版自动走本地引擎 |

## 2. 总体架构

```
┌─────────────────────────────────────────────┐
│  Web UI（public/：index.html + app.js + style.css）│   ← 零改动
└──────────────────┬──────────────────────────┘
                   │ 所有请求只经过 api()（app.js 第 15 行唯一 fetch 封装）
        ┌──────────┴──────────┐
        │  双模式切换（环境检测）│
        └────┬───────────┬────┘
   服务器版（现状）      App 版（已实现）
   fetch → server.mjs   public/local-handler.mjs（本地 API 路由）
   (node:sqlite)        ├─ 题库：public/sqljs-engine.mjs（sql.js WASM，读 tiku_app.db）
                        ├─ 记录：public/idb-store.mjs（IndexedDB，单用户）
                        ├─ 图片：公式图 images.db 打包 + 真图形按需缓存（sw-local.js）
                        └─ AI：public/ai-local.mjs（浏览器 fetch / Capacitor 用 CapacitorHttp 直调）
```

关键事实（2026-08-11 已重新核实，大改后）：
- app.js 全部 API 调用只经过一个 fetch 封装（第 15 行 `api()`）→ 双模式只改这一个函数，UI 零改动；`window.__LOCAL_API_PROMISE__` 由 `local-bootstrap.js` 注入
- 判分逻辑前端已有 `judge(q, sel)`（第 55 行，与 server 已对齐）→ 直接复用
- **server.mjs 大改后主库已切换为 `tiku.db`**（行 22；早期版本用 data/kaogong.db）
- 当前题库：**95867 题 / 2455 套卷**（数字推理已删，两端残留 0）；含 `<img` 题 **10817 道**（公式图与真图形约 1:2.4）
- 打包产物 `app-assets/`（builtAt 2026-08-11 06:55，与源库数据一致、无需重打包）：
  - `tiku_app.db` 130.2MB / `tiku_app.db.gz` 36.1MB（papers 2455 + questions 95867 + question_categories 54439 + q_materials 2029 + q_material_map 56963 + materials 7733）
  - `images.db.gz` 0.76MB（公式图 1896 张已下载入库；真图形 5271 张按需缓存不预下载）
  - `report.json`（打包验证报告）+ `benchmark.md`（性能基准：随机出题 2ms、章节树 2ms）

## 3. 技术选型（决策表）

| 决策点 | 选择 | 理由 / 备选 |
|---|---|---|
| App 壳 | **Capacitor**（@capacitor/core + @capacitor/android） | 现有前端是纯 SPA，套壳零重写；备选 uni-app 需重写 |
| 手机端 SQLite | **sql.js WASM（当前已实现并验证）**；阶段 5 可换 capacitor-sqlite | sql.js 零插件、浏览器即可验证（已验证）；capacitor-sqlite 原生加载更快但需真机验证；适配器接口（get/all/run）已统一，可互换 |
| 个人记录存储 | **IndexedDB**（idb-store.mjs） | 纯前端无插件；单用户无需 user_id |
| AI 直调 | **浏览器 fetch；Capacitor 环境用 CapacitorHttp**（@capacitor/core 内置） | WebView fetch 会被 CORS 拦，原生层请求无此问题 |
| 图片本地化 | 公式图打 asset（images.db）；真图形 IndexedDB/文件缓存 | 见 §2 实测数据 |
| 构建环境 | **JDK 17 + Android Studio（含 SDK）+ Gradle** | 一次性安装约 3-5GB；命令行 sdkmanager 备选 |
| 目标平台 | **仅 Android** | Windows 无法构建 iOS（需 Mac + Xcode + 开发者账号），iOS 暂不做 |

依赖隔离：**所有 npm 依赖（Capacitor 等）只存在于新 App 目录**，现有 server 版保持零依赖不动。

## 4. 分阶段实施（阶段 1-4 完成 + 大改后复验 ✅）

### 阶段 1：题库离线化（打包脚本）— 完成
- [x] `build-app-assets.mjs`：从 tiku.db 生成 App 用只读题库资源（去冗余列、VACUUM、gzip 压缩）→ `app-assets/tiku_app.db.gz` **36.1MB**（目标 ≤60MB 达标）
- [x] 下载打包公式图 → `images.db.gz` **0.76MB**（1896 张），供离线显示公式
- [x] 选型实验：sql.js 加载方案验证通过（见 benchmark.md）
- [x] ✅ 验证：`report.json` 全项通过（科目 4 类、随机 10 题 2ms、章节树 2ms、材料映射、单题、套卷详情）
- [x] ✅ **大改后复验（2026-08-11）**：产物行数与当前 tiku.db 完全一致（95867/2455），数字推理残留 0，**无需重打包**

### 阶段 2：离线查询引擎（local-api）— 完成
- [x] 抽取纯查询逻辑：subjects / categories / papers / chapters / 随机出题 / 单题 / 材料 → `lib/local-queries.mjs`（与 server 同构，调用方注入 {get,all} 适配器）
- [x] `public/local-api.mjs` + `public/local-handler.mjs`：本地 API 路由，返回结构与 server 逐字段对齐（含错题本/收藏/统计读接口）
- [x] `public/sqljs-engine.mjs`：sql.js 浏览器引擎适配器（get/all/run）+ images.db → IndexedDB 导入
- [x] 判分复用现有 `judge(q, sel)`，不改动
- [x] ✅ 验证：`test-local-queries.mjs` 全过（含与 server 返回结构逐项对齐）
- [x] ✅ **大改后复验（2026-08-11）**：修正 2 处过时断言后全绿——① 综应 chapters 已按"只留 A 类"断言（`['A类·综合管理']`）；② 申论测试 group 由已不存在的 `案例分析题` 改为 `归纳概括题`（大改后申论单独建树 SHENLUN_TREE）

### 阶段 3：本地记录存储（IndexedDB）— 完成
- [x] `public/idb-store.mjs`：`records` / `favorites` 两个 store（单用户无 user_id 列；**stats 不落库，由记录实时聚合**——与 server 版差异）
- [x] 记录类接口在 `public/local-api.mjs` 就绪；`initLocalApiBrowser` 自动接 IndexedDB
- [x] ✅ 验证：`test-local-api.mjs` 全过（favorites 增删/分页、records 同日去重、stats/wrong/recent、doneBySubject、chapterStats、subStats、公式 URL 改写）
- [x] ✅ 浏览器端 `test-idb.html` 全流程通过（含关进程后数据保留）

### 阶段 4：双模式适配 + AI + 图片缓存 + 跳过登录 — 完成
- [x] `api()` 双模式切换：检测 Capacitor/`?local=1` 自动切本地路由
- [x] **本地模式跳过登录**：认证模块已在早期删除（无登录/注册界面），打开即进题库
- [x] AI：`public/ai-local.mjs` 设置页自填 key（空值不覆盖、脱敏回显）、直调 OpenAI 兼容接口、解析缓存 IndexedDB、断网/未配置可读降级提示
- [x] 图片：`public/sw-local.js` 公式图本地提供 + 真图形首次联网自动缓存 + 未缓存占位
- [x] ✅ 验证：无 server 浏览器全流程可用；断网模拟通过；服务器模式回归正常
- [x] ✅ **大改后复验（2026-08-11）**：`node --test` 三个离线测试 + `npm test`（verify-db + e2e-check）**全部通过**

### 阶段 5：Capacitor 打包 + 真机验收 — ✅ 完成（2026-08-11，真机验收待用户）
- [x] 新建 `app/` 目录：npm init + 安装 @capacitor/core@6.2.1、@capacitor/android@6.2.1、@capacitor/cli@6.2.1（仅此目录）
- [x] 配置：App 名「没钱考什么公」、webDir 直连 public/、androidScheme https；构建环境复用已有 **JDK 17.0.1 + Android SDK**（platforms/android-36.1 + build-tools/36.0.0），**无需安装 Android Studio**
- [x] Gradle 构建：官方源超时 → 腾讯云镜像 + bin 包 + networkTimeout 600s；AAPT 资源冲突（foo.db 与 foo.db.gz 视为重复）→ assets 只保留 `tiku_app.db` + `images.db`
- [x] **真机首测发现并修复**：App 报"下载题库失败 HTTP 404 (tiku_app.db.gz)"——根因：**Android aapt2 打包 assets 时会自动解压 `.gz` 文件并去掉扩展名**（tiku_app.db.gz → tiku_app.db 明文），App 请求 .gz 必然 404。修复：local-bootstrap.js 改为请求未压缩 `./app-assets/tiku_app.db`（130MB SQLite 明文，APK 内由 zip 压缩到 ~36MB），浏览器联调同步改（fetchBuf 对非 .gz 不 gunzip，既有 images.db 路径已覆盖）；重新构建并验证 APK 内文件与前端请求路径一致
- [x] **真机二测发现并修复**：App 报"Failed to fetch dynamically imported module: https://localhost/local-api.mjs"——两个根因：① **Android WebView 的 MimeTypeMap 不认识 `.mjs`**，ES module 加载被拒；② `local-api.mjs`/`local-handler.mjs` import `../lib/local-queries.mjs`，**lib/ 在 public/ 外未打进 APK**。修复：public/ 全部 `.mjs` 改名为 `.js`（含 lib 依赖副本：新建 `public/lib/` 放 local-queries.js/fenbi-tree.js/xingce-chapter-map.js，浏览器专用 .js 版与 node 原版 lib/*.mjs 并存），所有 import 引用同步更新（local-bootstrap.js 4 处动态 import、test-idb.html、test-local-api.mjs、app.js 注释）；验证：node --check 全过 + 3 个离线测试全绿 + npm test 全绿 + APK 内确认 lib/ 与 .js 模块存在且无 .mjs
- [x] **全面回归测试（用户要求重测）**：新增 2 个自动化测试并全部通过——① `test-local-ai.mjs`（13 项）：**更改 prompt 立即生效 + 跨实例持久化 + promptChanged 标记**、**更改 skill 为技能包名后完整注入**（fetch bundle + system 消息含 Skill 全文 + skill_loaded 状态）、api_key 空值/脱敏不覆盖、未配置 key 降级、断网降级、explain 未找到题、clearExplainCache、material 返回 {text}；② `test-local-handler.mjs`（5 项）：**app.js 全部 35 条 API 调用路径本地模式均有实现**（含 /papers/:id、DELETE /ai/explain-cache、POST /check 参数）；③ 合并命令 `npm run test:local`（44 项全绿）+ npm test 全绿 + 12 个前端文件 node --check 全过；④ 核对 app.js 无绕过 api() 的直接 fetch、POST /records 字段（questionId/correct/costMs）与 local addRecord 一致；⑤ 裁剪器遮罩优化（55%→28% 黑、overlay 94%→55%），新 APK 已构建
- [x] **debug APK 43.9MB** + **release 签名 APK 40MB**（自签名 keystore `kaogong-release.keystore`，CN=Kaogong，apksigner 验证通过）→ 项目根 `没钱考什么公-release.apk`
- [x] 输出《手机安装使用说明.md》
- [ ] **真机验收**（用户手机）：安装、全功能回归、断网测试、AI 测试 —— 用户自行安装按说明验收

## 5. 大改后修复记录（2026-08-11，本轮）

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 1 | `test-local-queries.mjs` 综应 chapters 断言失败 | 测试断言还期望 A/B/C/D 四类，大改后"综应只留 A 类"（ZONGYING_TREE 仅 A 类，server/local 两端一致） | 断言改为 `['A类·综合管理']` |
| 2 | `test-local-api.mjs` 申论取题崩溃 | 测试用 group `案例分析题`，大改后申论单独建树（SHENLUN_TREE 五题型），该 group 无题 | 改为 `归纳概括题` |
| 3 | 刷题偶发"出 0 题"（综应 A 类应用文写作） | ①残留 `node server.mjs 3000` 进程与测试 server 并发写 practice.db → SQLITE_BUSY；②**trimToMax 整组移除导致空结果**（n=2 抽中同一大材料组，扩容超 max 后整组删光） | ①杀残留进程；②trimToMax 裁剪后不足 max 时按原顺序补足（组完整性让步于题量规则） |
| 4 | 全科目偶发出不满 15 题（职测/数量关系 12-13 题） | ①randomQuestions 窗口抽样 flaky（id 空间密度低/聚集，10 次×4 倍窗口偶发不足）；②全科目抽中多个材料组时 enrich 扩容 → trimToMax 裁剪单题后不足 15 | ①窗口 8 倍 + 20 次尝试 + **ORDER BY RANDOM() 全量兜底**；②同 #3 补足逻辑 |

修复后：`test-random-practice-count.mjs` 24/24 **连跑 6 次全绿**（修复前 6 次 4 挂）；`test-local-queries` / `test-local-api` / `npm test` 全绿。

## 6. 新增 / 修改文件清单（现状）

| 文件 | 状态 | 说明 |
|---|---|---|
| `build-app-assets.mjs` | ✅ 已有 | 打包脚本：题库精简 + 公式图下载 + images.db |
| `app-assets/` | ✅ 已有 | 产物：tiku_app.db.gz 36.1MB + images.db.gz 0.76MB + report.json + benchmark.md |
| `lib/local-queries.mjs` | ✅ 已有 | 离线查询引擎（纯 SQL+组装层，与 server 同构） |
| `public/local-api.mjs` | ✅ 已有 | 本地 API 层（query/records/ai/stats） |
| `public/local-handler.mjs` | ✅ 已有 | 本地路由（/api/* → 本地实现） |
| `public/local-bootstrap.js` | ✅ 已有 | 模式检测 + 引擎加载 + 注入 `__LOCAL_API_PROMISE__` |
| `public/sqljs-engine.mjs` | ✅ 已有 | sql.js 适配器（阶段 5 可换 capacitor-sqlite） |
| `public/idb-store.mjs` | ✅ 已有 | IndexedDB 记录存储 |
| `public/ai-local.mjs` | ✅ 已有 | AI 本地直调 + 降级 |
| `public/sw-local.js` | ✅ 已有 | 图片离线 Service Worker |
| `public/vendor/sqljs/` | ✅ 已有 | sql.js 浏览器资源 |
| `public/app.js` / `index.html` | ✅ 已改 | api() 双模式 + local-bootstrap 引入 |
| `test-local-queries.mjs` / `test-local-api.mjs` / `test-random-practice-count.mjs` | ✅ 已有（本轮修断言） | 离线链路回归测试 |
| `app/`（Capacitor 工程） | ⬜ 待建 | 阶段 5 |
| `手机安装使用说明.md` | ⬜ 待建 | 阶段 5 |

## 7. 验收清单（真机）

- [ ] APK 安装成功，桌面出现「考公刷题」图标，点击直接进入题库首页（**无登录界面**）
- [ ] 随机练习：出题 → 作答 → 判分 → 看解析，全流程正常
- [ ] 套卷/章节/材料题浏览正常；**飞行模式（完全断网）下以上全部可用**
- [ ] 公式题离线显示正常（公式图来自本地打包）
- [ ] 图形题：联网首次查看正常，二次查看断网也正常（已缓存）；未缓存图显示占位不报错
- [ ] 错题本/收藏/刷题统计增删查正常，**杀进程重启后数据仍在**
- [ ] AI 解析：设置页填入 key 后可用；断网时提示"AI 需要联网"；key 未填时提示去设置
- [ ] 服务器版回归：`node server.mjs 3000` 后原功能不受影响

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Android Studio 下载 3-5GB，网络/磁盘不足 | 卡在阶段 5 | 阶段 1-4 已全部完成且在浏览器无 server 模式验证通过，构建环境可后补 |
| capacitor-sqlite 插件兼容性问题 | 阶段 5 | 当前 sql.js 方案已可用（App 内已验证），capacitor-sqlite 作为可选项；查询 SQL 两者通用 |
| 36MB 题库首次复制到 App 沙盒慢 | 首次启动体验 | 启动画面 + 首次初始化进度提示 |
| 真图形 5271 张按需缓存 | 离线看图不完整 | 仅收藏/错题的图优先缓存；未缓存显示占位 |
| 题库版权 | 合规 | APK 仅自用，不公开发布（与现有约定一致） |
| iOS 无法打包 | 平台覆盖 | 本期仅 Android；如后续需要，需 Mac 环境另行计划 |

## 9. 需要你准备的东西（阶段 5 前）

- [ ] **约 3-5GB 磁盘空间**下载 Android Studio（阶段 5 之前装好即可）
- [ ] 一台 Android 手机（用于真机验收）
- [ ] 可选：自己的 AI API key（DeepSeek 等 OpenAI 兼容，测试用）

## 10. 工作量估算（剩余）

| 阶段 | 内容 | 估算 |
|---|---|---|
| 1-4 | 已全部完成 + 大改后复验通过 | 0（已完成） |
| 5 | Capacitor 打包 + 真机验收 | 1-1.5 天（含环境安装） |
| **合计剩余** | | **约 1-1.5 天** |

---

*下一步：批准阶段 5 后开工（装 JDK/Android Studio → 建 app/ 工程 → 打包 debug APK → 真机验收 → 签名 release）。*
