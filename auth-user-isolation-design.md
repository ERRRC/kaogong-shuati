# 登录 + 用户隔离：详细设计方案（v2 可审阅版）

> 目标：50 人内测，各自拥有独立的错题本/收藏/刷题记录/统计；你本人不登录也能用（游客模式）
> 约束：零依赖（不引第三方库）、零成本（不接短信/第三方登录）、向后兼容（不登录行为与现在完全一致）
> 现状依据：server.mjs 全部 26 个 API 路由已逐一盘点（见 §4）

---

## 1. 关键决策（先看这个，有异议随时提）

| # | 决策 | 理由 | 备选 |
|---|---|---|---|
| D1 | **管理员批量建号**（`node adduser.mjs add 小明 123456`），邀请码自助注册作备用 | 50 人内测你直接发账号，谁是谁一目了然；不花钱 | 邀请码自助注册（已留接口） |
| D2 | **token 存 sessions 表**（有状态），不用 JWT | 能主动踢人、能统计在线、零依赖实现简单 | JWT（无状态但踢人麻烦） |
| D3 | **密码 scrypt 哈希**存储，绝不明文 | node:crypto 自带，抗暴力破解 | bcrypt（要引依赖，不必） |
| D4 | **游客模式**：不登录 → 数据存 `user_id IS NULL` 空间 | 你个人使用零变化；登录后看不到游客数据 | 强制登录（会挡住你自己） |
| D5 | **ai_explains 不加 user_id**，全局共享缓存 | 解析内容与用户无关；别人解析过的题你直接命中缓存，**省 API 钱** | 每用户一份（浪费） |
| D6 | 登录/注册**限流**：IP+用户名 5 次失败锁 15 分钟 | 防爆破，内存 Map 实现 | 无（裸奔） |

## 2. 数据库设计（完整 SQL）

### 2.1 新增 users 表（昵称即登录名）

```sql
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,                  -- 格式 scrypt$<saltHex>$<hashHex>
  role          TEXT NOT NULL DEFAULT 'user',   -- user / admin
  status        INTEGER NOT NULL DEFAULT 1,     -- 1 正常 / 0 禁用
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  last_login_at TEXT
);
```

### 2.2 新增 sessions 表（有状态 token）

```sql
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,                  -- randomBytes(32).toString('hex')
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at TEXT NOT NULL,                     -- 30 天
  user_agent TEXT DEFAULT ''                    -- 记录设备，排查用
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
```

### 2.3 现有表加 user_id 列（启动时自动迁移，复用 server.mjs 现有 archived 列同款 try/catch 模式）

```sql
ALTER TABLE practice_records ADD COLUMN user_id INTEGER DEFAULT NULL;  -- 已存在则 catch 忽略
ALTER TABLE favorites      ADD COLUMN user_id INTEGER DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_records_user ON practice_records(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fav_user      ON favorites(user_id);
```

`user_id NULL` = 游客 + 你现有的 310 条历史记录，天然兼容，不动。

### 2.4 ⚠️ favorites 重建（唯一的坑，SQLite 改不了 UNIQUE 约束）

现表约束 `question_id UNIQUE` → 多用户收藏同一题直接报错。重建：

```sql
BEGIN;
CREATE TABLE favorites_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  user_id INTEGER DEFAULT NULL,
  subject TEXT DEFAULT '',
  chapter TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX idx_fav_uid_qid ON favorites_new(user_id, question_id);
INSERT INTO favorites_new (id, question_id, user_id, subject, chapter, created_at)
  SELECT id, question_id, NULL, subject, chapter, created_at FROM favorites;
DROP TABLE favorites;
ALTER TABLE favorites_new RENAME TO favorites;
COMMIT;
```

> SQLite 中 NULL 不参与唯一性 → 游客之间、游客与登录用户之间不冲突。
> 回滚：`git` 无此库，直接备份 `practice.db` 文件即可（实施前复制一份）。

### 2.5 明确不动 user_id 的表

| 表 | 处理 | 理由 |
|---|---|---|
| ai_explains | 全局共享 | 缓存与用户无关，共享省 API 钱（D5） |
| materials / q_materials / q_material_map / question_categories | 不动 | 共享只读数据 |
| tiku.db（96MB 题库） | 不动 | 只读 |

## 3. 认证实现（lib/auth.mjs 完整代码，约 60 行）

```js
// lib/auth.mjs —— 零依赖，node:crypto 自带
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pdb = new DatabaseSync(path.join(__dirname, '..', 'practice.db'));
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;  // 30 天

// ---- 密码哈希 ----
export function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(pw, stored) {
  try {
    const [, salt, hash] = String(stored).split('$');
    const calc = scryptSync(pw, salt, 64);
    return timingSafeEqual(calc, Buffer.from(hash, 'hex')); // 恒定时间，防时序攻击
  } catch { return false; }
}

// ---- 会话 ----
export function createSession(userId, userAgent = '') {
  const token = randomBytes(32).toString('hex');
  pdb.prepare('INSERT INTO sessions (token, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)')
    .run(token, userId, new Date(Date.now() + TOKEN_TTL_MS).toISOString(), userAgent.slice(0, 200));
  return token;
}
export function getUserByToken(token) {
  if (!token) return null;
  const s = pdb.prepare('SELECT s.user_id, s.expires_at, u.username, u.role, u.status FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) { pdb.prepare('DELETE FROM sessions WHERE token = ?').run(token); return null; }
  if (s.status !== 1) return null;  // 被禁用
  return { id: s.user_id, username: s.username, role: s.role };
}
export function deleteSession(token) { pdb.prepare('DELETE FROM sessions WHERE token = ?').run(token); }
```

**server.mjs 接入（两处，改动最小）：**

```js
// ① 路由分发最前面，统一解析 token（所有 /api/* 请求都过）
const auth = getUserByToken(req.headers.authorization?.replace(/^Bearer\s+/i, ''));
req.user = auth;   // {id, username, role} 或 null

// ② 用户数据接口的隔离条件统一生成（防漏改某处）
function userScope(req) {
  return req.user ? { sql: 'user_id = ?', params: [req.user.id] }
                  : { sql: 'user_id IS NULL', params: [] };
}
```

> 用法示例：`SELECT ... FROM practice_records WHERE ${sc.sql} AND is_correct = 0`，参数 `...sc.params`。

## 4. 接口改造清单（server.mjs 全部 26 个路由逐一核对）

### 4.1 新增 7 个接口

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| POST | /api/auth/register | 邀请码自助注册（备用） | 公开 |
| POST | /api/auth/login | 昵称+密码 → `{ token, user }` | 公开 |
| POST | /api/auth/logout | 删会话 | 登录 |
| GET | /api/auth/me | 校验 token → 用户信息 | 登录 |
| POST | /api/admin/users | 批量建测试账号 | admin |
| GET | /api/admin/users | 账号列表/状态 | admin |
| POST | /api/admin/users/:id/ban | 禁用/解禁（踢人） | admin |

**登录请求/响应示例：**
```jsonc
POST /api/auth/login
{ "username": "小明", "password": "123456" }
// 200
{ "ok": true, "data": { "token": "9f2c...64位hex", "user": { "id": 1, "username": "小明", "role": "user" } } }
// 错误
{ "ok": false, "error": { "code": "BAD_CREDENTIALS", "message": "昵称或密码错误" } }
// 锁定
{ "ok": false, "error": { "code": "LOCKED", "message": "失败次数过多，请 15 分钟后再试" } }
```

### 4.2 改造 11 个用户数据接口（统一套 userScope）

| # | 接口（行号） | 现状 | 改造 |
|---|---|---|---|
| 1 | GET /api/favorites (678) | 查全部 | `WHERE user_id = ?`（登录）/ `IS NULL`（游客） |
| 2 | POST/DELETE /api/favorites (699) | 写全局 | 插入/删除带 user_id |
| 3 | POST /api/check (712) | 判分 | 判分本身无状态；若写记录则带 user_id |
| 4 | POST /api/records (723) | 提交记录 | INSERT 带 user_id |
| 5 | GET /api/records/stats (745) | 统计全部 | 条件加 userScope |
| 6 | GET /api/records/wrong (794) | 错题本全部 | 条件加 userScope |
| 7 | DELETE /api/records/wrong (820) | 删全部 | 条件加 userScope |
| 8 | GET /api/records/recent (829) | 最近全部 | 条件加 userScope |
| 9 | GET /api/subjects (449) | 含 done 统计 JOIN practice_records | JOIN 条件加 userScope |
| 10 | GET /api/chapters (555) | 含做题统计 | JOIN 条件加 userScope |
| 11 | POST /api/ai/progress (1010) | 学习进度顾问读统计 | 同 stats，加 userScope |

### 4.3 只读接口（不改）：categories、papers、papers/:id、materials、practice、question

### 4.4 AI 管理接口（配套安全方案 ai-key-security.md，本次仅登记）

`/api/ai/agents*`、`/api/ai/explain`、`/api/ai/ocr`、`/api/ai/grade`、`/api/ai/material`：
登录落地后改为 **admin 角色可管理配置**（agents GET/PUT/history/test），**登录用户可调用**（explain/ocr/grade/material，配合限流）。

## 5. 前端改造（public/）

### 5.1 页面结构（新增 2 个视图 + 1 个弹层，app.js 现有 renderXxx 模式）

```
renderLogin()   全屏登录页：品牌区 + 【登录/注册】tab + 底部"先逛逛（游客模式）"
renderProfile() 个人页：昵称/注册时间/刷题总数/退出登录；admin 显示"测试者列表"
（AI 设置入口收进个人页，仅 admin 可见）
```

### 5.2 fetch 统一封装（app.js 所有 fetch 改走此函数，约 15 行）

```js
const TOKEN_KEY = 'kg_token';
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {                 // token 失效统一处理
    localStorage.removeItem(TOKEN_KEY);
    renderLogin();
    throw new Error('登录已过期');
  }
  return res.json();
}
```

### 5.3 启动流程

```
index.html 载入 → init()
  ├─ localStorage 有 token → GET /api/auth/me
  │     ├─ 200 → 首页（右上角显示昵称）
  │     └─ 401 → 清 token → renderLogin()
  └─ 无 token → renderLogin()（"先逛逛" → 游客模式进首页）
```

### 5.4 安全细节
- 用户名渲染用 `textContent` / 转义函数，禁止拼 innerHTML（防 XSS）
- 密码输入框 `type="password"` + 前端不做任何日志打印
- 登录/注册按钮防连点（提交中禁用）

## 6. 管理员工具（adduser.mjs，约 50 行）

```
node adduser.mjs add 小明 123456            # 建普通账号
node adduser.mjs add 我 admin123 --admin    # 建管理员
node adduser.mjs list                       # 列表（含最后登录时间）
node adduser.mjs ban 小明                   # 禁用
node adduser.mjs unban 小明                 # 解禁
node adduser.mjs invite KGB2026 50          # 生成邀请码（备用自助注册）
```

## 7. 测试计划（新增 e2e-auth.mjs，并入 npm test）

| # | 用例 | 断言 |
|---|---|---|
| 1 | 注册→登录→me | 拿到 token，me 返回正确用户 |
| 2 | **隔离核心**：A 提交 3 题 → B 查错题本 | A 有 3 条，B 有 0 条 |
| 3 | 游客提交 2 题 → 登录后查错题本 | 登录用户看不到游客数据（0 条） |
| 4 | 收藏同一题：A、B 各自收藏 | 都成功，互不覆盖（验证 favorites 重建） |
| 5 | 错密码 5 次 | 第 6 次返回 LOCKED |
| 6 | 伪造/过期 token | 401 |
| 7 | 禁用用户登录 | 返回 403/禁用提示 |
| 8 | admin 接口非 admin 调用 | 403 |
| 9 | 回归 | verify-db + e2e-check 全绿 |
| 10 | Playwright 冒烟 | 登录页 UI、登录→刷题→退出、游客模式、375px 移动端 |

## 8. 实施步骤（每步独立验证，可中途停下）

| # | 步骤 | 验证 |
|---|---|---|
| 1 | 备份 practice.db → 建表迁移 + favorites 重建（§2） | 重启服务，日志无报错 |
| 2 | lib/auth.mjs + server.mjs 接入（§3） | curl 注册/登录/me |
| 3 | 4.1 新增 7 个接口 + 限流 | curl 全场景 |
| 4 | adduser.mjs | 建 3 个号、list、ban |
| 5 | 4.2 逐个改造 11 个接口（用 userScope） | 每改一个 curl 验证 |
| 6 | 前端登录页/个人页/fetch 封装（§5） | 浏览器实测 |
| 7 | e2e-auth.mjs + 全量回归 | npm test 全绿 |
| 8 | AI 接口权限收紧 + 限流（配合 ai-key-security.md） | 非 admin 403 |

## 9. 工作量与风险

- **工作量**：约 2~3 天（含测试），0 元
- **风险点**：① favorites 重建（§2.4，先备份可回滚）；② 11 个接口漏改（用统一 userScope 规避，改完逐个 curl）；③ 前端 401 死循环（renderLogin 前判断当前页）
- **不影响**：题库数据、AI 配置、现有游客历史数据

## 10. 遗留问题（本期不做）

- 找回密码（管理员 ban/unban + 重置即可）
- 头像/昵称修改/排行榜
- 短信/微信登录（要钱要资质，阶段 2 再议）
