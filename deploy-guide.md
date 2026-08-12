# 公网部署指南（50 人测试版）

> 目标：让 50 个测试者在手机/电脑上通过 https://域名 访问你的刷题 App
> 前提：登录+用户隔离（auth-user-isolation-design.md）、AI 密钥防护（ai-key-security.md）已按方案落地
> 本机：Windows（PowerShell）；服务器：Ubuntu 22.04（本文所有命令以它为准）

---

## 0. 三条路线先对比，选一条

| | **A. 海外服务器免备案**（推荐） | B. 国内服务器 + 备案 | C. 内网穿透 |
|---|---|---|---|
| 费用 | 3~5 美元/月（~30元/月） | 轻量 2C2G 新用户 ~99元/年 | 0~10元/月 |
| 时效 | **当天可上线** | 1~2 周（等备案） | 当天 |
| 稳定性 | 好（香港/新加坡延迟 ~30-60ms） | 最好 | 差（免费版限速/掉线） |
| HTTPS | 免费（Caddy 自动证书） | 免费（备案后同样） | 麻烦（免费域名/端口受限） |
| 域名 | 建议 .top/.xyz（首年 ~10元） | 必须备案 | 可用免费子域 |
| 适合 | **熟人 50 人内测，预算少** | 正式长期运营 | 只有 1-2 人临时用 |

**推荐 A**：50 人熟人测试，免备案当天上线，总成本约 **150~250 元/年**（服务器 + 域名）。

---

## 1. 路线 A 完整步骤（照着做即可）

### 1.1 买服务器
- 商家：搬瓦工 / DigitalOcean / Vultr / RackNerd（选**香港或新加坡**节点，延迟低）
- 配置：**2 核 2G 起**，Ubuntu 22.04，20GB 磁盘（数据 ~140MB，足够）
- 买完记下：IP、root 密码（或 SSH 密钥）

### 1.2 本机装 WinSCP（上传文件用，图形化最简单）
- 官网下载 WinSCP 安装 → 协议选 **SCP**，填 IP/root/密码 → 登录
- 或用命令行（Windows 10+ 自带）：
  ```powershell
  scp -r server.mjs public lib tiku.db materials.db ai-config.db root@你的IP:/opt/kaogong/
  ```

**⚠️ 上传清单与排除（很重要）**

| 必须传 | 不要传 |
|---|---|
| server.mjs、public/、lib/（去掉缓存文件） | cookie.txt（粉笔 cookie，敏感，服务器不需要） |
| tiku.db（91.6MB 题库，核心） | .chrome-*/、out/、tmp-*.mjs、*.png 截图 |
| materials.db（26.6MB 申论材料） | practice.db（**可选**：传 = 带你的历史数据；不传 = 服务器新建干净的，测试者从零开始。建议：不传，内测数据与个人数据分开） |
| ai-config.db（含 AI key，**务必用 SCP 加密传输**） | .git / node_modules |

### 1.3 服务器装 Node.js（⚠️ 版本坑：必须 ≥ 22.13，否则 node:sqlite 直接崩）

```bash
ssh root@你的IP
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v        # 必须显示 v22.13.0 或更高（本机是 v24 也能跑）
```

### 1.4 首次启动验证（先手动跑一次）

```bash
cd /opt/kaogong
node server.mjs 3000
# 看到 "✅ 考公刷题服务已启动" 即成功；Ctrl+C 停掉
```

### 1.5 进程守护（pm2：崩溃自启 + 开机自启）

```bash
sudo npm i -g pm2
# 建生态文件（把 ADMIN_KEY 换成随机口令，生成命令：openssl rand -hex 16）
cat > /opt/kaogong/ecosystem.config.cjs <<'EOF'
module.exports = {
  apps: [{
    name: 'kaogong',
    script: 'server.mjs',
    env: { ADMIN_KEY: '替换成你的随机口令' },
    max_memory_restart: '300M'
  }]
};
EOF
cd /opt/kaogong
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup      # 按提示复制执行那行输出，实现开机自启
pm2 logs kaogong             # 看日志
```

### 1.6 域名 + HTTPS（Caddy 自动证书，最省事）

1. 买域名：阿里云/腾讯云/Namecheap 都行，**.top 首年约 10 元**；海外服务器无需备案
2. 在域名商 DNS 管理加一条 **A 记录**：`kaogong` → 你的服务器 IP（或直接裸域）
3. 服务器装 Caddy（自动申请 Let's Encrypt 证书）：
   ```bash
   sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update && sudo apt install caddy
   ```
4. 编辑 Caddyfile（替换成你的域名）：
   ```bash
   sudo nano /etc/caddy/Caddyfile
   ```
   ```caddy
   kaogong.你的域名.top {
       reverse_proxy 127.0.0.1:3000
   }
   ```
   ```bash
   sudo systemctl reload caddy
   # 等 1 分钟，HTTPS 证书自动生效
   ```

### 1.7 防火墙（关键：3000 端口不裸奔，只留 80/443/22）

- **云厂商控制台**：安全组只放行 22、80、443（不放 3000——绕过 Caddy 直连裸端口等于自暴）
- **服务器内**：
  ```bash
  sudo ufw allow 22,80,443/tcp && sudo ufw enable
  ```

### 1.8 每日备份（practice.db 是测试者的刷题数据，丢了哭）

```bash
sudo apt install -y sqlite3
crontab -e   # 添加下面一行（每天凌晨 3 点备份，保留 14 天）
```
```cron
0 3 * * * mkdir -p /opt/kaogong/backup && sqlite3 /opt/kaogong/practice.db ".backup '/opt/kaogong/backup/practice-$(date +\%F).db'" && find /opt/kaogong/backup -mtime +14 -delete
```

### 1.9 部署后验证清单（每项打勾）

- [ ] 电脑浏览器打开 `https://kaogong.你的域名.top` 正常加载
- [ ] 地址栏有锁 🔒（HTTPS 生效）
- [ ] **手机切到 4G/5G**（不用 WiFi）再打开——排除局域网假象
- [ ] 注册/登录可用，A、B 两账号错题本互不可见（隔离验证）
- [ ] 刷题、判分、错题本、收藏、AI 解析全流程
- [ ] 试一个错误密码 5 次 → 提示锁定
- [ ] `curl -I https://kaogong.你的域名.top` 返回 200

---

## 2. 路线 B（国内服务器）与 A 的差异

- 服务器买腾讯云/阿里云**轻量应用服务器**（新用户 2C2G 约 99元/年）
- **多一步备案**：域名实名 → 阿里云/腾讯云备案系统提交 → 等 1~2 周 → 备案号挂到网站底部
- 备案期间不能用域名，可先用 IP:3000 临时测（体验差，仅自测）
- 其余步骤（Node/pm2/Caddy/防火墙/备份）与 A 完全相同

## 3. 路线 C（内网穿透）与 A 的差异

- 零服务器：本机跑 `node server.mjs 3000` + cpolar/frp 穿透
- 免费版：域名随机、限速、可能掉线——只适合 1-2 人临时演示
- HTTPS：cpolar 付费版才有固定域名+证书（~10元/月）
- **50 人测试不推荐**（掉线一次测试者就跑光了）

---

## 4. 部署时的安全核对（配合 ai-key-security.md）

- [ ] `ADMIN_KEY` 已设置（1.5 步），AI 管理接口有口令保护
- [ ] 只开放 22/80/443，3000 不外露
- [ ] cookie.txt 没传上服务器
- [ ] 域名 A 记录解析正确，Caddy 日志无证书报错
- [ ] 测试者账号用 adduser.mjs 批量建，不开放自助注册

## 5. 常见坑速查

| 症状 | 原因 | 解决 |
|---|---|---|
| 启动报 `Cannot find module 'node:sqlite'` | 服务器 Node < 22.13 | 重装 Node 22 LTS（1.3 步） |
| 手机打不开，电脑能开 | 防火墙/安全组没放 80/443 | 见 1.7 |
| 证书报错/跳 http | 域名 A 记录没生效 / Caddyfile 域名写错 | DNS 生效后再 reload caddy |
| AI 解析全部失败 | ai-config.db 的 key 没传或已过期 | 服务器上重传 ai-config.db 或在 AI 设置页重填 |
| 图片显示裂图 | 粉笔 CDN 防盗链（no-referrer 已加，大部分可过） | 后续加服务端图片代理（roadmap P0 项） |
| 重启后服务没了 | 没跑 `pm2 startup` | 执行它输出的命令 |

## 6. 与现有文档的关系

- 登录/用户隔离 → `auth-user-isolation-design.md`
- AI 密钥防护 → `ai-key-security.md`
- 手机 App 化（PWA/套壳） → `app-roadmap.md`
