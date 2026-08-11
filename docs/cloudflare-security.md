# Cloudflare 配置清单 · chat.torasu.xyz

> 适用域名: `chat.torasu.xyz`
> 隧道: `84c4388f-3c6e-453f-b734-57108ca069a5` → `http://localhost:3000`
> 服务器已绑定 `127.0.0.1:3000`,公网无法直连,唯一入口为 Cloudflare。
> 套餐: **Free**(免费套餐,部分功能受限)

---

## 部署状态总览

| # | 类别 | 配置项 | 状态 |
|---|---|---|---|
| 1 | SSL/TLS | Encryption=Full, Always Use HTTPS, Min TLS=1.2 | ✅ 已部署 |
| 2 | Security | Bot Fight Mode=ON | ✅ 已部署 |
| 3 | WAF 自定义规则 1 | `block-bad-scanners`(封恶意 UA) | ✅ 已部署 |
| 4 | WAF 自定义规则 2 | `block-wrong-host`(防 IP 替换,支持子域名) | ✅ 已部署 |
| 5 | WAF 自定义规则 3 | `block-malicious-paths`(封 .env/wp-admin 等) | ✅ 已部署 |
| 6 | 速率限制规则 | `upload-rate-limit`(10秒3次,封10秒) | ✅ 已部署 |
| 7 | Cache Rule | `cache-uploads`(Edge TTL 1天, Browser TTL 4小时) | ✅ 已部署 |
| 8 | Redirect Rule | `force-https`(301 永久重定向到 HTTPS) | ✅ 已部署 |
| 9 | R2 对象存储 | bucket `chat-uploads` + r2.dev URL + 自定义域名(SSL 传播中) | ✅ 已部署 |
| 10 | 文件清理机制 | 撤回删文件 + 定时清理(每天 03:00)+ 手动清理 + 删除房间同步删消息与文件 + 空闲房间自动清理 + 前台失效占位 | ✅ 已部署 |

**规则配额使用情况**:
- 自定义规则: 3/5(还剩 2 条余量)
- 速率限制规则: 1/1(已满,免费套餐上限)
- Cache Rules: 1 条
- Redirect Rules: 1 条

---

## 1. SSL/TLS(基础)

路径:**SSL/TLS → Overview / Edge Certificates**

| 项目 | 设置 | 状态 |
|---|---|---|
| Encryption mode | **Full**(不是 Full Strict) | ✅ |
| Always Use HTTPS | ON | ✅ |
| Min TLS Version | 1.2 | ✅ |
| Opportunistic Encryption | 新版 UI 中为"随机加密",已默认启用 | ✅ |

> 用 Full 即可:cloudflared 到本地是明文 HTTP,Full Strict 会因证书校验失败。
> 注意:Always Use HTTPS 开关在 Cloudflare Tunnel 场景下可能不生效,实际强制跳转由第 8 项 Redirect Rule 实现。

---

## 2. Security(全局)

路径:**Security → Settings**

| 项目 | 设置 | 状态 |
|---|---|---|
| Bot Fight Mode | ON | ✅ |
| Security Level | 自动化(免费套餐不可调) | ⚠️ |
| Browser Integrity Check | 新版 UI 已移除 | ❌ |
| Challenge Passage | 新版 UI 已移除 | ❌ |
| Pass challenge site-wide | 新版 UI 已移除 | ❌ |

> 免费套餐的 Security Level 为自动化,无法手动设为 High。
> Browser Integrity Check 和 Challenge Passage 在新版 Cloudflare UI 中已合并或移除。

---

## 3. WAF Custom Rules

路径:**Security → 安全规则 → 自定义规则**(按优先级从上到下)

配额: **3/5 已使用**

### 规则 1:封禁已知恶意爬虫/扫描器 UA

- **Name**: `block-bad-scanners`
- **Expression**:
```cfwl
(http.user_agent contains "sqlmap") or
(http.user_agent contains "nikto") or
(http.user_agent contains "nmap") or
(http.user_agent contains "masscan") or
(http.user_agent contains "acunetix") or
(http.user_agent contains "nessus") or
(http.user_agent contains "dirbuster") or
(http.user_agent contains "gobuster") or
(http.user_agent eq "")
```
- **Action**: Block
- **状态**: ✅ 已部署

### 规则 2:阻止非本域名直连(防 IP 替换)

- **Name**: `block-wrong-host`
- **Expression**:
```cfwl
(not (ends_with(http.host, "torasu.xyz"))) and
(http.host ne "")
```
- **Action**: Block
- **说明**:防止有人把其他域名解析到你的 Cloudflare IP 借用配额。用 `ends_with` 匹配所有 `*.torasu.xyz` 子域名(含 `chat.torasu.xyz`、`img.torasu.xyz` 等)。
- **状态**: ✅ 已部署(2026-08-11 更新:从 `chat.torasu.xyz` 改为 `torasu.xyz`,支持所有一级子域名)
- **注意**: 通配符证书 `*.torasu.xyz` 只覆盖一级子域名,不要使用 `img.chat.torasu.xyz` 这样的二级子域名(SSL 会失败)

### 规则 3:封禁常见恶意路径扫描

- **Name**: `block-malicious-paths`
- **Expression**:
```cfwl
(http.request.uri.path contains "/.env") or
(http.request.uri.path contains "/wp-admin") or
(http.request.uri.path contains "/wp-login") or
(http.request.uri.path contains "/phpmyadmin") or
(http.request.uri.path contains "/xmlrpc.php") or
(http.request.uri.path contains "/.git") or
(http.request.uri.path contains "/config.php") or
(http.request.uri.path contains "/admin.php")
```
- **Action**: Block
- **说明**:封禁扫描器常扫的敏感路径(.env、wp-admin、phpmyadmin 等)
- **状态**: ✅ 已部署

### 跳过的规则(原因记录)

| 规则 | 原因 |
|---|---|
| `allow-websocket-upgrade`(Skip 操作) | 部署时报"意外错误",Skip 操作在免费套餐可能受限。不影响功能,因为现有 Block 规则不会误伤合法 WebSocket 请求 |
| `geo-block-optional`(按国家封禁) | 可选项,按需启用。剩余 2 条规则余量可随时添加 |

---

## 4. Rate Limiting Rules

路径:**Security → 安全规则 → 速率限制规则**

配额: **1/1 已使用**(免费套餐只能创建 1 条)

> 免费套餐限制:期间和持续时间都只能设为 **10 秒**。

### 唯一规则:文件上传接口限速

- **Name**: `upload-rate-limit`
- **If incoming requests match**:
```cfwl
(http.host eq "chat.torasu.xyz") and
(http.request.uri.path eq "/upload") and
(http.request.method eq "POST")
```
- **Characteristics**: IP Address
- **Period**: 10 seconds(套餐限制,无法设更长)
- **Requests**: 3
- **Action**: Block
- **Duration**: 10 seconds(套餐限制,无法设更长)
- **状态**: ✅ 已部署
- **说明**:10 秒窗口内同 IP 超过 3 次上传即拦截 10 秒。配合服务端 `UPLOAD_RATE_LIMIT_MS=3000`(每 3 秒 1 次)兜底,攻击者实际每分钟最多约 9-10 次上传。

### 跳过的规则(原因记录)

| 规则 | 原因 |
|---|---|
| `global-conn-limit`(全局速率) | 速率限制只能 1 条,优先给上传接口。全局限速交给服务端 `MAX_CONNECTIONS_PER_IP=10` 兜底 |
| `ws-upgrade-limit`(WebSocket 限速) | 同上。WebSocket 连接数由服务端 `MAX_CONNECTIONS_PER_IP=10` 限制 |
| `static-bypass`(静态资源防刷) | 同上。uploads 目录已通过 Cache Rule 缓存到边缘,刷静态资源不耗源站资源 |

---

## 5. Caching

路径:**Caching → Cache Rules**

### Cache Rule:缓存上传的静态文件

- **Name**: `cache-uploads`
- **Expression**:
```cfwl
(http.host eq "chat.torasu.xyz") and
(starts_with(http.request.uri.path, "/uploads/"))
```
- **Cache eligibility**: Eligible for cache(符合缓存条件)
- **Edge TTL**: 忽略缓存控制标头,使用 86400 秒(1 天)
- **Browser TTL**: 替代源服务器,使用 14400 秒(4 小时)
- **状态**: ✅ 已部署
- **说明**:图片上传后内容不变(文件名含 hash),可放心缓存,减轻源站带宽

> 注意:Cloudflare 表达式中字符串前缀匹配需用函数形式 `starts_with(字符串, 前缀)`,不是 `starts with`。

### Hotlink Protection(防盗链)

- **状态**: ❌ 未配置
- **原因**:免费套餐不可用,该功能仅在 Pro/Business 套餐中提供
- **替代方案**:如需防盗链,可用 WAF 自定义规则按 Referer 拦截(占用 1 个规则名额,当前剩余 2 条)

---

## 6. Redirect Rules(强制 HTTPS)

路径:**Rules → Redirect Rules**

### 规则:强制 HTTPS 跳转

- **Name**: `force-https`
- **模板**: 从 HTTP 重定向到 HTTPS
- **匹配条件**: `http://*`(所有 HTTP 请求)
- **操作**: 301 永久重定向
- **目标 URL**: `https://${1}`
- **状态**: ✅ 已部署
- **说明**:Always Use HTTPS 开关在 Cloudflare Tunnel 场景下可能不生效,用显式 Redirect Rule 实现强制跳转更可靠

---

## 7. Page Rules

路径:**Rules → Page Rules**

**未配置**。新版 Cloudflare 推荐使用 Cache Rules 和 Redirect Rules 替代 Page Rules,功能更灵活。

---

## 8. 应急:Under Attack Mode

路径:**Security → Settings**

- **何时启用**:遭遇持续攻击、流量异常飙升时
- **效果**:所有访问需通过 JS Challenge(5 秒延迟页)
- **注意**:WebSocket 升级可能受影响,启用后密切观察聊天室可用性
- **退出**:攻击平息后关闭

---

## 9. 验证结果(2026-08-11 执行)

所有规则均已通过 curl 验证:

| 验证项 | 期望 | 实际结果 | 状态 |
|---|---|---|---|
| 恶意 UA (sqlmap) | 403 | `403 Forbidden` | ✅ |
| 空 UA | 403 | `403 Forbidden` | ✅ |
| 恶意路径 (`/.env`) | 403 | `403 Forbidden` | ✅ |
| 正常访问 | 200 | `200 OK` | ✅ |
| 上传限速(连发 4 次) | 第 4 次 429 | 第 2/4 次 `429` | ✅ |
| uploads 缓存 | HIT + max-age=14400 | `cf-cache-status: HIT` + `Cache-Control: max-age=14400` | ✅ |
| HTTP→HTTPS 跳转 | 301 | `301 Moved Permanently` + `Location: https://chat.torasu.xyz/` | ✅ |

### 验证命令(Windows PowerShell,使用 curl.exe)

```powershell
# 1. 验证 HTTPS 强制跳转
curl.exe -I http://chat.torasu.xyz/
# 期望: 301 Moved Permanently, Location: https://chat.torasu.xyz/

# 2. 验证恶意 UA 被拦截
curl.exe -I -A "sqlmap/1.0" https://chat.torasu.xyz/
# 期望: 403 Forbidden

# 3. 验证空 UA 被拦截
curl.exe -I -H "User-Agent:" https://chat.torasu.xyz/
# 期望: 403 Forbidden

# 4. 验证恶意路径被拦截
curl.exe -I https://chat.torasu.xyz/.env
# 期望: 403 Forbidden

# 5. 验证上传限速(连发 4 次)
for ($i=1; $i -le 4; $i++) {
    Write-Host "--- Request $i ---"
    curl.exe -s -o NUL -w "Status: %{http_code}\n" -X POST -H "Content-Length: 1" -d "x" https://chat.torasu.xyz/upload
    Start-Sleep -Seconds 1
}
# 期望: 第 1 次 200,后续出现 429

# 6. 验证正常访问不受影响
curl.exe -I https://chat.torasu.xyz/
# 期望: 200 OK

# 7. 验证 uploads 缓存(用一个实际存在的文件)
curl.exe -I https://chat.torasu.xyz/uploads/<filename>.png
# 期望: cf-cache-status: HIT, Cache-Control: max-age=14400

# 8. 验证 WebSocket 仍可连接(浏览器控制台)
# new WebSocket("wss://chat.torasu.xyz/")
# 期望: 正常连上,无 5 秒挑战页
```

> 注意:PowerShell 中 `curl` 是 `Invoke-WebRequest` 的别名,语法不兼容。必须用 `curl.exe` 显式调用真正的 curl。

---

## 10. 监控建议

| 指标 | 在哪看 | 关注点 |
|---|---|---|
| Threats blocked | Cloudflare 仪表盘首页 | 每天被拦截的请求数 |
| Traffic → Requests | Analytics → 仪表板 | 异常流量峰值 |
| Security Events | Security → 分析 | 哪条规则在拦截 |
| 429/403 比例 | Analytics → HTTP 流量 | 正常用户是否被误伤 |

---

## 关键原则

- **边缘层规则宁严勿松**,误伤可通过 Security Events 看日志调整
- 服务端的 `MAX_CONNECTIONS=500`、单 IP 限 10、三层消息限流是**兜底**,不要把所有压力都留给后端
- 服务器绑定 `127.0.0.1:3000` 是防止绕过 Cloudflare 直连的根本措施
- `CF-Connecting-IP` 由 cloudflared 覆盖写入,客户端无法伪造

---

## 分层防御架构

```
攻击者
  │
  ├─路径 A:直连 IP:3000 ──→ ❌ 127.0.0.1 拒绝 + 防火墙阻断
  │
  └─路径 B:经 Cloudflare(唯一入口)
        │
        ▼
    Cloudflare 边缘防护
    ├─ DDoS 吸收
    ├─ WAF 规则(3 条:恶意 UA / 错误 Host / 恶意路径)
    ├─ 速率限制(上传接口 10秒3次)
    ├─ Bot Fight Mode
    ├─ 强制 HTTPS(301 重定向)
    ├─ Cache Rule(uploads 缓存)
    └─ R2 对象存储(图片/文件,10GB 免费)
        │
        ▼
    cloudflared 隧道(加密)
        │
        ▼
    Node 服务 · 127.0.0.1:3000
    ├─ MAX_CONNECTIONS=500
    ├─ MAX_CONNECTIONS_PER_IP=10
    ├─ 三层消息限流(200ms / 8条2秒 / 60条分钟)
    ├─ 上传限流(3秒间隔 / 10次分钟)
    ├─ MAX_MESSAGE_BYTES=64KB
    ├─ 文件上传到 R2(非本地磁盘)
    └─ 定时清理(每天 03:00 清撤回+孤儿文件)
```

---

## 配套服务端限制(server.js)

| 配置项 | 值 | 作用 |
|---|---|---|
| `HOST` | `127.0.0.1` | 仅本机连接,防直连 |
| `MAX_CONNECTIONS` | 500 | 全局最大并发 |
| `MAX_CONNECTIONS_PER_IP` | 10 | 单 IP 最大并发 |
| `RATE_LIMIT_MS` | 200ms | 单条消息最小间隔 |
| `MSG_WINDOW_LIMIT` / `MSG_WINDOW_MS` | 8 / 2000ms | 滑动窗口限流 |
| `MSG_PER_MINUTE_LIMIT` | 60 | 每分钟消息上限 |
| `UPLOAD_RATE_LIMIT_MS` | 3000ms | 上传频率限制 |
| `MAX_MESSAGE_BYTES` | 64KB | 单条消息大小上限 |
| `AUTO_CLEAN_ENABLED` | `1` | 启用定时清理(默认启用,设 `0` 禁用) |
| `AUTO_CLEAN_HOUR` | `3` | 每天凌晨 3 点执行(0-23) |
| `AUTO_CLEAN_OLD_DAYS` | `0` | 同时清理 N 天前旧消息(`0` = 只清撤回+孤儿,不删旧消息) |
| 文件存储 | Cloudflare R2 | 上传文件存到 R2,不占服务器磁盘 |

---

## 11. Cloudflare R2 对象存储(文件上传)

> 部署日期: 2026-08-11
> 用途: 替代本地 `uploads/` 目录,上传文件存到 R2,通过 Cloudflare CDN 加速访问

### R2 配置

| 项目 | 值 | 状态 |
|---|---|---|
| 账户 ID | `93c7539cf62b0ced89fe19ab98e87cf7` | ✅ |
| Bucket 名称 | `chat-uploads` | ✅ |
| Bucket 位置 | APAC(亚太) | ✅ |
| 存储类 | Standard | ✅ |
| API 令牌 | `chat-uploads-token`(对象读写) | ✅ |
| CORS 策略 | 允许所有来源 GET | ✅ |
| 自定义域名 | `img.torasu.xyz`(SSL 已生效) | ✅ |
| r2.dev URL | `https://pub-53301c8fde864d7480eb03bdf451e7e1.r2.dev`(备用) | ✅ |

### 当前公共 URL

```
R2_PUBLIC_URL=https://img.torasu.xyz
```

> **自定义域名已生效**:通配符证书 `*.torasu.xyz` 覆盖 `img.torasu.xyz`(一级子域名),SSL 握手成功,文件可正常访问。
> **重要**: 不要使用 `img.chat.torasu.xyz` 这样的二级子域名,通配符证书 `*.torasu.xyz` 不覆盖二级子域名,SSL 会失败。

### 免费额度

| 项目 | 免费额度 | 备注 |
|---|---|---|
| 存储 | 10 GB / 月 | 足够存约 2-5 万张图片 |
| A 类操作(写) | 100 万次 / 月 | 上传文件 |
| B 类操作(读) | 1000 万次 / 月 | 访问文件 |
| 出口流量 | **完全免费** | 不像 AWS S3 收流量费 |

### 代码改动

| 文件 | 改动 |
|---|---|
| [r2.js](file:///d:/ChatRoom/r2.js) | 新增:R2 客户端模块(initR2/uploadToR2/deleteFromR2/isR2Enabled) |
| [server.js](file:///d:/ChatRoom/server.js) | /upload 接口改为双模式:R2 优先,未配置时 fallback 到本地 |
| [.env](file:///d:/ChatRoom/.env) | 添加 R2_* 配置项 |
| [.env.example](file:///d:/ChatRoom/.env.example) | 添加 R2 配置示例和步骤说明 |

### 验证结果(2026-08-11)

| 验证项 | 期望 | 实际结果 | 状态 |
|---|---|---|---|
| 服务器启动识别 R2 | 启动日志显示"文件存储: Cloudflare R2" | 显示正确 | ✅ |
| 文本文件上传 | 返回 R2 URL | `https://img.torasu.xyz/...txt` | ✅ |
| 文件访问(自定义域名) | 返回文件内容 | "Test upload via custom domain img.torasu.xyz" | ✅ |
| SSL 证书 | 通配符证书覆盖 | `*.torasu.xyz` 覆盖 `img.torasu.xyz` | ✅ |
| 文件在 bucket 中可见 | R2 仪表盘显示对象 | 文件名/大小/时间正确 | ✅ |

---

## 12. 文件清理机制(孤儿文件处理)

> 部署日期: 2026-08-11
> 用途: 定期清理 R2 中不再被消息引用的孤儿文件,避免占用免费 10GB 存储配额

### 清理触发方式

| 方式 | 触发时机 | 执行内容 | 操作者 |
|---|---|---|---|
| **撤回消息** | 用户/管理员撤回消息时 | 标记 `revoked=1`,异步删除该消息关联的 R2 文件 | 自动 |
| **删除房间** | 房主/管理员删除房间、空闲房间到期、清理孤儿房间时 | 删除该房间全部消息记录 + 消息引用的实际文件(本地/R2) | 房主/管理员/自动 |
| **定时清理** | 每天凌晨 `AUTO_CLEAN_HOUR` 点 | 删除所有 `revoked=1` 消息记录 + 孤儿文件 | 自动 |
| **手动清理** | 管理员后台点击按钮 | 同定时清理,或按天数清理旧消息 | 管理员 |
| **立即触发** | 管理员后台"立即触发"按钮 | 等同定时任务立即执行一次 | 管理员 |
| **空闲房间自动清理** | 每 5 分钟扫描一次 | 删除空闲超过设定时长且无人使用的公开房间(含消息与文件) | 自动 |

### 环境变量配置(.env)

```bash
AUTO_CLEAN_ENABLED=1       # 启用定时清理(0=禁用,默认启用)
AUTO_CLEAN_HOUR=3          # 每天凌晨 3 点执行(0-23,默认 3)
AUTO_CLEAN_OLD_DAYS=0      # 同时清理 N 天前旧消息(0=只清撤回+孤儿,>0 则同步删旧消息)
```

> 默认配置:每天 03:00 执行,仅清理撤回消息和孤儿文件,不删除旧消息。
> 如需清理 30 天前的旧消息,设 `AUTO_CLEAN_OLD_DAYS=30`。

### 清理范围

| 清理对象 | 触发条件 | 本地模式 | R2 模式 |
|---|---|---|---|
| 撤回消息文件 | 撤回消息时 | 删除 `uploads/` 中对应文件 | 调用 `r2.deleteFromR2(key)` |
| 撤回消息记录 | 定时/手动清理 | 从 `messages.json` 移除 | `DELETE FROM messages WHERE revoked=1` |
| 孤儿文件 | 定时/手动清理 | 扫描 `uploads/` 找不被引用的 | 从数据库反查 `file_url` 找撤回消息的文件 |
| 旧消息 | `AUTO_CLEAN_OLD_DAYS>0` | 按 `time` 字段过滤 | `DELETE FROM messages WHERE time < ?` |
| 孤儿房间 | 手动清理 | 无房主的非 default 房间,删消息 + 引用的文件 | 同左,删消息 + `deleteFile` 删文件 |
| 被删除房间的消息与文件 | 房主/管理员删除房间、空闲房间到期 | 删除该房间消息 + `uploads/` 中对应文件 | 删除该房间消息 + `r2.deleteFromR2(key)` |

> **R2 模式限制**:R2 API 不支持列举 bucket 中所有对象(需 ListObjects 权限),因此 R2 模式只能通过数据库反查撤回消息的 `file_url` 来删除,无法发现"数据库中无记录但 R2 中存在"的孤儿。本地模式则可扫描磁盘文件做完整对比。

### 代码改动

| 文件 | 改动 |
|---|---|
| [storage.js](file:///d:/ChatRoom/storage.js) | 新增 `extractFileName()`、`deleteFile()`、`deleteR2File()`、`deleteDiskFile()`,统一文件删除入口;`revokeMessage()` 撤回时同步删文件;`cleanOldMessages()` / `cleanRevokedAndOrphans()` 调用 `deleteFile()`;`deleteRoom()` / `cleanOrphanRooms()` 删除房间时同步收集并删除消息引用的文件;新增 `updateRoomEmptySince()` / `listExpiredPublicRooms()` 支撑空闲房间清理 |
| [r2.js](file:///d:/ChatRoom/r2.js) | 新增 `deleteFromR2(key)` 方法,调用 S3 `DeleteObjectCommand` |
| [server.js](file:///d:/ChatRoom/server.js) | 新增定时清理调度器 `startAutoCleanScheduler()`;新增 `admin_get_clean_config` / `admin_trigger_auto_clean` 消息处理;手动清理后广播 `history_invalidated` 通知;新增空闲房间扫描调度器 `startIdleRoomScheduler()`(每 5 分钟)与 `syncRoomIdleState()`(加入/离开/断线时同步空闲标记),到期房间踢回成员后删除并广播 `room_deleted(reason:'idle')` |
| [public/index.html](file:///d:/ChatRoom/public/index.html) | 图片 `onerror` 显示 SVG 占位图;文件卡片点击前 HEAD 预检;处理 `history_invalidated` 自动重新拉取历史;管理后台新增定时清理配置展示和"立即触发"按钮;创建房间弹窗新增"空闲自动清理"超时选项(公开房间可选);房间列表/管理后台/侧边栏显示 `⏱` 空闲超时标记;`room_deleted` 支持空闲清理原因文案 |

### 后台删除文件后前台显示行为

| 后台操作 | 前台表现 |
|---|---|
| 撤回消息 | 显示"消息已撤回"(原有逻辑) |
| 清理撤回记录 | 收到 `history_invalidated`,自动重新拉取历史,撤回消息从列表消失 |
| 清理旧消息 | 收到 `history_invalidated`,重新拉取后旧消息消失 |
| 删除孤儿文件 | 已加载的图片/文件仍显示占位,通过 `onerror` / HEAD 检测显示"已失效" |
| 定时清理触发 | 在线管理员收到 `admin_auto_clean_done` 系统消息,统计自动刷新 |

### 验证结果(2026-08-11)

| 验证项 | 期望 | 实际结果 | 状态 |
|---|---|---|---|
| 服务启动识别定时清理 | 日志显示"定时清理: 已启用(每天 3:00)" | 显示正确 | ✅ |
| 下次执行时间 | 显示明天 03:00 | `2026/8/12 03:00:00` | ✅ |
| 管理后台配置展示 | 显示启用状态/执行时间/下次执行 | 正确显示 | ✅ |
| 撤回消息文件删除 | R2 中对应对象被删除 | 验证通过 | ✅ |
| 服务启动识别空闲清理 | 日志显示"房间空闲清理: 已启用(每 5 分钟扫描)" | 显示正确 | ✅ |
| 创建房间指定超时 | 公开房间 `idle_timeout_hours` 生效,私密/非法值被忽略 | 验证通过 | ✅ |
| 加入/离开房间空闲标记 | 加入清除 `empty_since`,离开设置 `empty_since` | 验证通过 | ✅ |
| 到期房间查询与删除 | `listExpiredPublicRooms` 查出到期房间并删除 | 验证通过 | ✅ |
| 删除房间同步删文件 | 删除房间后其消息记录与引用的文件一并删除,其它房间引用的文件不受影响 | 本地 6/6 验证通过 | ✅ |
| 删除房间同步删 R2 文件 | 真实上传到 R2 → 删除房间 → 对象被删除(HTTP 404),API 令牌具备 DeleteObject 权限 | 6/6 验证通过 | ✅ |

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-08-11 | 初始部署:SSL/TLS、Bot Fight Mode、3 条 WAF 规则、1 条速率限制规则、Cache Rule、Redirect Rule。所有规则验证通过。 |
| 2026-08-11 | WAF 规则 `block-wrong-host` 表达式更新:从 `eq` 改为 `ends_with`,支持 `img.chat.torasu.xyz` 等 R2 子域名。 |
| 2026-08-11 | R2 对象存储部署:创建 bucket `chat-uploads`(APAC)、API 令牌、CORS 策略、自定义域名 `img.torasu.xyz`(SSL 已生效)。代码改动:r2.js 新增、server.js /upload 改为双模式、.env 添加 R2 配置。上传/访问验证通过。 |
| 2026-08-11 | 自定义域名从 `img.chat.torasu.xyz` 改为 `img.torasu.xyz`(一级子域名),解决通配符证书 `*.torasu.xyz` 不覆盖二级子域名的 SSL 问题。WAF 规则 `block-wrong-host` 表达式更新为 `ends_with(http.host, "torasu.xyz")`,允许所有一级子域名。 |
| 2026-08-11 | 文件清理机制部署:撤回消息同步删 R2 文件;新增定时清理调度器(每天 03:00,通过 `AUTO_CLEAN_ENABLED` / `AUTO_CLEAN_HOUR` / `AUTO_CLEAN_OLD_DAYS` 环境变量配置);管理后台新增定时清理配置展示和"立即触发"按钮;前端图片 `onerror` 显示占位图、文件卡片 HEAD 预检、`history_invalidated` 自动重新拉取历史。新增第 12 章"文件清理机制"。 |
| 2026-08-11 | 公开房间空闲自动清理部署:创建房间可选空闲超时(1h-7天,仅公开房间);加入/离开/断线同步 `empty_since` 空闲标记;每 5 分钟扫描到期房间,将成员踢回公共大厅后删除并广播 `room_deleted(reason:'idle')`;前端创建弹窗新增超时选项、各房间列表显示 `⏱` 标记、删除提示区分空闲原因。 |
| 2026-08-11 | 删除房间同步清理文件:`deleteRoom()` / `cleanOrphanRooms()` 删除房间时,同步收集该房间消息引用的文件并调用 `deleteFile()` 删除(本地 `uploads/` 或 R2 `DeleteObject`),验证 6/6 通过;修复登录/设昵称后立即操作被入口竞态静默丢弃的问题。 |
