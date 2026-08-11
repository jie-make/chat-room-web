# 轻量化聊天室

轻量化即时文字聊天程序（Node.js + WebSocket），支持多房间群聊、私聊、文件上传、账号体系与多管理员管理，可部署到 Cloudflare 隧道后提供公网服务。

## 功能特性

- **多房间群聊**：公开/私密/密码房间，多房间并行加入，侧边栏切换会话，房间内在线列表按房间统计
- **账号系统**：注册（用户名+昵称+密码，bcrypt 哈希）、登录（密码 / Token 自动登录，"记住我"30 天）、登出、修改密码
- **快速进入**：临时用户免注册直接进入
- **多管理员**：主管理员（`.env` 配置，单点登录）+ 子管理员（权限受限，不能管理管理员列表、踢管理员、重置数据库）
- **房主/房间"管理"权限体系**：房主可委托/取消房间"管理"头衔；"管理"可踢普通成员、禁言，但不能对房主、其他管理、管理员使用；头衔与房主身份持久保留
- **私聊**：点对点会话、未读数、离线消息提示
- **文件上传**：图片/文件直传 Cloudflare R2（未配置则本地 uploads/），Buffer 方案不落地磁盘，单文件上限 50MB
- **上传可追溯性**：每次上传自动记录文件名、上传者昵称、注册用户 ID、来源 IP、房间、大小、类型与时间，管理员后台可搜索（按上传者/IP/文件名）
- **消息管理**：撤回（2 分钟窗口）、引用回复、图片灯箱预览、失效文件占位提示
- **权限与风控**：单 IP 连接数上限（50）、消息限流、注册频率限制（同 IP 10 分钟 3 次 / 24 小时 10 次）、强制下线（分钟可小数、永久封禁、到期自动解禁）、昵称保护
- **定时清理**：每天凌晨 3:00 清理撤回消息+孤儿文件（可配置时间/是否清理旧消息），管理后台支持手动清理
- **空闲房间清理**：公开房间长时间无人自动清理（可配置超时时长）
- **管理后台**：房间/用户搜索与管理、管理员列表管理、清理统计、定时清理配置
- **移动端适配**：侧边栏抽屉化、长按消息操作、全屏弹窗
- **连接/踢人日志**：服务端实时输出 `[conn]`/`[kick]` 日志，记录 IP、昵称、进入/断开、强制下线原因

## 技术栈

- Node.js + [ws](https://github.com/websockets/ws)（WebSocket）
- 存储双模式：MySQL（`mysql2`）或本地 JSON 文件（messages.json / rooms.json / users.json / sessions.json / uploads.json）
- 文件存储：Cloudflare R2（AWS S3 SDK）或本地 uploads/
- 密码哈希：bcrypt

## 快速开始

```bash
npm install
cp .env.example .env    # 按需修改配置
npm start               # 或 node server.js
```

启动后访问 http://localhost:3000 。

## 配置说明（.env）

| 变量 | 说明 | 默认 |
|---|---|---|
| `USE_MYSQL` | 使用 MySQL（`false` 则文件存储） | `true` |
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` | MySQL 连接配置 | 127.0.0.1:3306 / root / chat_db |
| `PORT` / `HOST` | 服务端口与监听地址 | 3000 / 0.0.0.0 |
| `ADMIN_NAME` / `ADMIN_PASSWORD` | 主管理员昵称与密码（快速进入时填写密码即获管理员权限） | admin / 空 |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` / `R2_PUBLIC_URL` | Cloudflare R2 对象存储（可选） | — |
| `AUTO_CLEAN_ENABLED` | 启用每天定时清理 | 1 |
| `AUTO_CLEAN_HOUR` | 定时清理时刻（0-23） | 3 |
| `AUTO_CLEAN_OLD_DAYS` | 同时清理 N 天前旧消息（0=只清撤回+孤儿） | 0 |
| `DISABLE_IP_LIMIT` | 禁用单 IP 连接数限制（仅测试用） | 0 |

## 目录结构

```
server.js          # WebSocket 服务与业务逻辑
storage.js         # 存储层（MySQL / 文件双模式）
r2.js              # Cloudflare R2 上传/删除封装
public/index.html  # 前端页面
docs/              # 部署与安全文档
clean/             # 数据库清理脚本
*.env*             # 环境配置
CHANGELOG.md 已合并至本文件「更新日志」章节
```

## 安全与部署

- 公网部署建议通过 Cloudflare Tunnel，详见 [docs/cloudflare-security.md](docs/cloudflare-security.md)（SSL、WAF、速率限制、缓存、防御架构与部署清单）
- 服务器绑定 0.0.0.0 时注意防火墙；纯内网环境对外只暴露 Cloudflare 路径
- 同 IP 多设备（同一路由器 NAT）不会互相挤下线：互踢仅基于同名/同账号，IP 只用于连接数与注册频率限制
- 所有注册账号单点登录：同一账号在新设备登录会自动顶掉旧设备连接（旧设备 session 同步作废，需重新登录，避免循环抢登）

## 更新日志

### 2026-08-11

**新增：移动端右侧操作面板**

移动端（≤640px）重新设计操作入口：header 右上角新增 "⋮" 按钮打开右侧抽屉（80vw，最大 320px），除在线人数外的所有操作按钮（房间列表、房间管理、管理后台、修改密码、登出/切换）均移入该面板，header 仅保留在线人数。

- **面板内容**：当前用户信息（昵称 + 管理员徽章）、房间列表、房间管理（房主/管理员/房间管理可见）、管理后台（管理员可见）、修改密码（注册用户/主管理员可见）、登出/切换、在线用户列表（含搜索、房主/管理标签、私聊/踢人操作）
- **页面约束**：从面板打开的房间列表/管理后台/改密等 modal，卡片约束在面板宽度内靠右显示，关闭后返回面板菜单；点击 modal 左侧遮罩可关闭回到面板
- **状态同步**：`renderUserList`/`updateOnlineCount`/`updateRoomAdminBtn`/`name_set` 均同步刷新面板内的用户列表、在线人数、按钮显隐；被顶下线/登出时自动关闭面板
- **关闭按钮固定**：所有 modal 与管理后台的 "×" 改为 `position: sticky` 固定在面板顶部，长内容滚动时不随内容上移（顺带修复 `#adminclose` 选择器与 `id="admin-close"` 不匹配的 bug）
- 桌面端（>640px）保持原有布局与按钮不变，操作面板仅移动端显示

涉及文件：`public/index.html`（操作面板 CSS/HTML/JS、header 按钮隐藏、modal 约束、关闭按钮 sticky）

**新增：刷新后保持登录状态（含临时用户）**

此前刷新网页后所有用户均需重新输入昵称或密码。现实现双端持久化自动登录：

- **注册用户**：已有 `chat_token` 机制，页面重载后自动发送 token 恢复登录态
- **临时用户**：首次 `set_name` 成功后，昵称保存至 `localStorage`（`chat_guest_name`）；刷新页面时自动发送 `set_name` 恢复身份，无需重新输入
- **清理时机**：登出、被顶下线、修改密码、登录过期时同步清除 `chat_guest_name`，避免误恢复
- **兼容性**：注册/登录成功后自动清除临时身份，临时用户升级为注册用户后无缝切换

涉及文件：`public/index.html`（`name_set` 保存临时昵称、`ws.onopen` 自动恢复、退出清理逻辑）

**修复：移动端打开界面自动呼出输入法**

移动端（≤640px）每次打开含输入框的弹窗/面板时会自动聚焦并弹出软键盘，遮挡界面、破坏体验。新增 `autoFocus(el)` 辅助函数（内部复用 `isMobile()` 检测），移动端跳过所有弹窗/面板/页面加载时的自动聚焦，用户主动操作（Enter 键切换字段、发送消息后回到输入框、点击引用回复）不受影响。桌面端行为不变。

涉及弹窗：登录/注册/游客标签页、创建房间、加入房间密码框、房间列表搜索、在线用户搜索、修改密码、切换房间、登录完成。

涉及文件：`public/index.html`（`autoFocus()` + 12 处替换）

**新增：房间"管理"头衔功能**

房主可委托当前房间在线用户为"管理"头衔，也可取消；管理员同样可以设置/取消。"管理"权限低于房主和管理员，无法对房主、其他管理、管理员使用权限。

- 权限模型：房主/管理员可设置/取消管理、踢人、禁言；房间"管理"可踢普通成员、可禁言，但不能踢房主/其他管理/管理员，也不能设置管理；普通用户无管理权限
- 持久化：退出房间再加入保留"管理"头衔；房主离开再进入仍是房主（除非房间被关闭）
- 设置管理时目标必须在线，离线用户被拒
- 在线用户列表显示"管理"标签，房管面板新增"房间管理"区块

涉及文件：`storage.js`（rooms 表 `managers` 字段、`setRoomManager()`）、`server.js`（`set_room_manager` 消息、`isRoomManager()`、`room_kick`/`room_mute` 权限升级）、`public/index.html`（管理区块、标签、`room_managers_changed` 处理）

**新增：连接与踢人日志**

服务端终端实时输出日志：`[conn] 连接建立/用户进入/连接断开`（含 IP、昵称、身份）与 `[kick] 强制下线`（原因、目标、IP）。仅输出到控制台，不写入文件。涉及文件：`server.js`

**新增：群聊（房间）未读服务端持久化**

此前房间未读仅存于前端内存，刷新/换设备后清零；且多房间下自己发送的消息可能被误计为未读。已参照私聊方案持久化：

- **服务端**：新增 `room_read_status` 表（user_name + room_id + last_read_at），`markRoomRead()` 记录最后已读时间、`listRoomUnreads()` 计算未读数（= 房间内、非我发送、时间 > 最后已读时间、未撤回的消息数）、`clearRoomReadStatus()` 在房间删除时清理
- **已读时机**：首次加入房间（非 silent）视为已读（历史不产生未读）；进入公共大厅即标记 default 已读；切换房间 / 正在查看的房间收到消息时发送 `mark_room_read` 同步
- **恢复**：`joined_rooms` 响应附带各房间未读数，刷新/重新登录/换设备后侧边栏 badge 恢复；silent 恢复（重连）保留原未读不清零
- **修复误计**：收到非当前会话的 chat 消息时排除自己的消息（`msg.name !== myName`）
- 验证：`_test_room_unread.js`（8/8：B 发 2 条→A 刷新重登未读恢复 2→标记已读后归零、自己消息不误计）通过

涉及文件：`storage.js`（room_read_status 表 + markRoomRead/listRoomUnreads/clearRoomReadStatus）、`server.js`（mark_room_read 消息、joined_rooms 附带未读、join_room silent 保留未读）、`public/index.html`（切换房间标记已读、chat 排除自己、joined_rooms 应用服务端未读）

**修复：注册用户登出/换设备后无法恢复已加入的房间**

此前注册用户退出登录后，前端清空 localStorage 中的已加入房间记录（`chat_joined_rooms`），且服务端未持久化，导致重新登录后房间列表丢失、无法自动恢复。

- **服务端持久化**：users 表新增 `joined_rooms` 字段（JSON 数组），注册用户加入房间时记录（`addUserRoom`）、离开/被踢出时移除（`removeUserRoom`）；房间被删除/清理时从所有用户记录中同步移除（`removeRoomFromAllUsers`，在 `deleteRoom`/`cleanOrphanRooms`/`resetDatabase` 中调用）
- **登录恢复**：`joined_rooms` 请求合并返回"当前内存房间 + 持久化房间"（去重）；前端收到后对不在当前会话中的房间自动发送 `join_room`（`silent`）静默恢复，侧边栏重新出现该房间并可正常收发消息
- **登出仍清空 localStorage**（防止同浏览器换账号误恢复），但服务端数据保留，重新登录后从服务端拉取
- 兼容旧 users 表自动 `ALTER TABLE users ADD COLUMN joined_rooms TEXT`
- 验证：`_test_persist_rooms.js`（10/10：注册→加房→登出→重登→恢复→离开后不再恢复）、`_test_persist_frontend.js`（6/6：模拟前端 joined_rooms 自动恢复+发消息）全部通过

涉及文件：`storage.js`（users.joined_rooms 字段 + 持久化方法）、`server.js`（join/leave/room_kick 记录 + joined_rooms 合并）、`public/index.html`（joined_rooms 自动 silent join 恢复）

**修复：手机端房间"异常关闭"（实为重连后 UI 丢失）**

创建带空闲计时的房间后，手机端可能几秒内"房间消失并回到公共大厅"，只在手机端复现。动态测试证明服务端房间生命周期正常（未误删），根因是手机网络波动导致 WebSocket 重连，`name_set` 后前端 `joinedRooms` 被重置为仅含 default，已加入的房间从侧边栏消失（看起来像被关闭）。

- 已加入房间持久化到 `localStorage`（`chat_joined_rooms`），`room_joined` 时保存、`room_left`/`room_deleted`/被顶下线/登出时移除
- 重连/刷新后 `name_set` 处理中自动向已保存的房间发送 `join_room`（新增 `silent` 参数：重连静默恢复，房间已删或需密码时不打扰用户）
- 验证：创建 5 分钟空闲房间 → 加入 → 3 秒后仍在（不误删）→ 断开重连 → silent 恢复加入原房间，13/13 通过

涉及文件：`server.js`（`join_room` 支持 `silent`）、`public/index.html`（房间持久化 + 重连自动恢复）、`_test_minute_idle.js`

**变更：空闲清理时间与强制下线时间改为分钟自定义输入**

- 房间空闲清理：创建房间弹窗由小时下拉改为数字输入（分钟），0 = 不自动清理，上限 7 天（10080 分钟）。`idle_timeout_hours` 字段由 INT 迁移为 DOUBLE（支持分钟级小数小时），兼容旧表自动 `ALTER MODIFY`；文件模式 `listExpiredPublicRooms` 条件由 `>=1` 改为 `>0`，使小于 1 小时的房间也能被清理
- 强制下线：管理后台"强制下线"由下拉改为数字输入（分钟，0 = 永久禁止进入，上限 10080 分钟）；在线用户列表与用户管理弹窗同步改为分钟输入并校验上限，服务端 `admin_kick` 对超过 10080 的时长自动截断
- 房间状态显示：设置自动清理时间的房间，房间列表显示"⏱ 房间持续 N 分钟无人后关闭并清理"，侧边栏显示"持续 N 分钟无人后关闭"，管理后台显示"⏱ N 分钟空闲清理"（`idleMinutes()` 将小时换算为分钟）
- 验证：`_test_minute_idle.js`（13/13）、`_test_kick_minutes.js`（7/7：0=永久、超限截断 10080）、`_test_room_manager.js`（19/19）、`_test_kick_login.js`（8/8）全部通过

涉及文件：`storage.js`（DOUBLE 迁移 + `createRoom` 小数小时 + `listExpiredPublicRooms` 条件）、`server.js`（`admin_kick` 上限 10080）、`public/index.html`（分钟输入 + 显示文案）

**修复：换设备登录同一账号时被误拒/卡住**

换设备登录同账号时，首次尝试可能卡在"连接中/登录中"或显示异常，需刷新后才成功。根因有三处：

- **登录双响应 bug**：登录分支先返回 `login_result ok:true`（并生成 session token），之后才检查同名占用并返回 `ok:false`，导致前端先存入 token 再显示失败，状态错乱。已改为占用检查通过后才返回成功，同一连接只响应一次
- **离线残留占用**：旧设备断网/关机后，其 WebSocket 在服务端心跳清理前仍占用昵称，新设备登录被误判为"已在其他设备登录"。新增 `purgeStaleNameSockets()`，登录/进入/注册前先清理已失效（非 OPEN）的同名连接
- **前端连接卡死**：`waitConnected` 在连接中途断开后 interval 永久等待，按钮一直停在"连接中/登录中"。改为轮询式重建，连接丢失自动重连（最多 5 次）

同时加固：`completeEntrance` 进入流程异常时清理已登记身份，避免昵称残留；注册时同步踢掉占用同昵称的临时用户，防止双连接共存。

涉及文件：`server.js`（登录/快速进入/注册分支、`purgeStaleNameSockets()`、`completeEntrance` 容错）、`public/index.html`（`waitConnected` 重建逻辑）、`_test_login_fix.js`（8/8 通过）

**变更：账号登录改为顶号（单点登录）**

此前同一账号在其他设备在线时，新设备登录会被拒绝（提示"该账号已在其他设备登录"）。现改为**以新连接代替旧连接**：任一注册账号在新设备登录（账号密码或 token）会自动顶掉旧设备的同名连接，一次登录直接进入，无需刷新重试。

- 顶号同时**作废旧连接的 session**（`kickSameNameSockets()`），旧设备 token 立即失效、刷新后需重新登录，避免新旧设备无限循环抢登
- 同名临时用户被注册用户顶掉（快速进入同名临时昵称时同理）
- 主管理员（jie）保持原有顶号行为，与普通账号统一走同一逻辑
- 注册昵称长度与快速进入对齐（限制 20 字符，`set_name` 截断一致），避免同名匹配不一致

涉及文件：`server.js`（`kickSameNameSockets()`、登录/快速进入/注册分支）、`storage.js`（注册昵称长度校验）、`public/index.html`（注册表单昵称校验）、`_test_kick_login.js`（顶号验证 8/8 通过，含防抢登）

**新增：上传可追溯性**

每次文件上传自动记录来源信息，供事后追责：

- 记录内容：文件名、文件 URL、上传者昵称、注册用户 ID（`user_id`，临时用户为空）、来源 IP、大小、MIME、是否图片、来源房间、上传时间
- 身份获取：前端上传时携带 `X-Uploader`（昵称）/ `X-Token`（注册用户登录 token，服务端校验后解析 `user_id`）/ `X-Room-Id`（来源房间）；`X-Uploader`/`X-Token` 均不信任客户端自述，昵称与 IP 由服务端从请求与连接解析
- 存储：MySQL 新增 `uploads` 表（索引 uploader/ip/created_at）；文件模式新增 `uploads.json`（`recordUpload()` / `listUploads()`，`saveUploadsFile()` 持久化）
- 管理后台：新增"上传记录"区块，打开管理面板自动加载，支持按上传者/IP/文件名搜索，展示图片/文件、注册/临时标签与元信息；仅管理员可见，非管理员请求被拒
- 限制：单 IP 每分钟最多 10 次上传，单次间隔 3 秒（沿用原有上传限流）

涉及文件：`storage.js`（uploads 表 + `recordUpload`/`listUploads`）、`server.js`（`/upload` 身份头解析 + `admin_list_uploads` 消息）、`public/index.html`（上传记录区块与 `uploadFile()` 身份头）、`_test_uploads.js`（端到端测试 17/17 通过）

**修复：公共大厅（default 房间）owner 脏数据**

默认房间 `owner` 曾被错误设为管理员名（storage 初始化/重置遗留）。已改为空字符串并清理现有数据库脏数据，管理后台正确显示"房主: 无"，管理员权限不受影响。涉及文件：`storage.js`

**变更：IP 限制策略调整**

同一路由器（NAT）下多台设备曾被误判为同一 IP 互相挤下线。按成熟产品惯例调整：

- 移除"同 IP 新连接踢所有旧连接"：同 IP 下不同昵称/账号可共存
- 单 IP 连接数上限 10 → 50（仍用于防 DDoS）
- 新增注册频率限制：同一 IP 10 分钟最多注册 3 次，24 小时内最多 10 次
- 保留：同名互踢（注册用户顶临时用户、主管理员单点登录）、消息限流、强制下线禁令

涉及文件：`server.js`
