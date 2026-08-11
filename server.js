// 轻量化即时文字聊天程序 - 服务端
// 依赖：ws；可选 mysql2/dotenv（启用 MySQL 时）
require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const storage = require('./storage');
const r2 = require('./r2');

// ============ 配置 ============
const PORT = process.env.PORT || 3000;
// 安全:只监听 127.0.0.1,仅本机 cloudflared 可连接,公网无法直连
// 如需局域网测试,设环境变量 HOST=0.0.0.0(仅测试用,生产环境必须 127.0.0.1)
const HOST = process.env.HOST || '127.0.0.1';
const MAX_MSG_LENGTH = 4000;
const MAX_NAME_LENGTH = 20;
const MAX_QUOTE_LENGTH = 500;
const RATE_LIMIT_MS = 200;            // 单条消息最小间隔(毫秒)
const MSG_WINDOW_LIMIT = 8;           // 滑动窗口内最大消息数
const MSG_WINDOW_MS = 2000;           // 滑动窗口时长(2 秒)
const MSG_PER_MINUTE_LIMIT = 60;      // 每分钟最大消息数
const MAX_CONNECTIONS = 500;          // 服务器最大并发连接数
const MAX_CONNECTIONS_PER_IP = 50;    // 单 IP 最大并发连接数(超过此值视为异常)
// 注册频率限制(防批量注册):同一 IP 短时间内最多注册 N 次
const REGISTER_RATE_WINDOW_MS = 10 * 60 * 1000;       // 10 分钟滑动窗口
const REGISTER_RATE_LIMIT = 3;                        // 窗口内最多 3 次
const REGISTER_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 小时窗口
const REGISTER_DAILY_LIMIT = 10;                      // 24 小时内最多 10 次
// 测试模式: 禁用 IP 单会话限制(环境变量 DISABLE_IP_LIMIT=1 时生效,仅用于负载测试)
const DISABLE_IP_LIMIT = process.env.DISABLE_IP_LIMIT === '1' || process.env.DISABLE_IP_LIMIT === 'true';
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB
const UPLOAD_RATE_LIMIT_MS = 3000;    // 上传频率限制(每 3 秒一次)
const MAX_MESSAGE_BYTES = 64 * 1024;  // 单条 WebSocket 消息最大字节(64KB,防止超大包)
const REVOKE_WINDOW_MS = 2 * 60 * 1000; // 普通用户 2 分钟内可撤回
const HEARTBEAT_INTERVAL = 30 * 1000; // 心跳检测间隔：30 秒

// 定时清理配置(通过环境变量可调)
// AUTO_CLEAN_ENABLED=1 启用每天自动清理(默认启用)
// AUTO_CLEAN_HOUR=3 每天凌晨 3 点执行(默认 3,0-23)
// AUTO_CLEAN_OLD_DAYS=30 同时清理 30 天前的旧消息(设为 0 表示只清撤回+孤儿,不删旧消息)
const AUTO_CLEAN_ENABLED = process.env.AUTO_CLEAN_ENABLED !== '0' && process.env.AUTO_CLEAN_ENABLED !== 'false';
const AUTO_CLEAN_HOUR = Math.max(0, Math.min(23, parseInt(process.env.AUTO_CLEAN_HOUR || '3', 10)));
const AUTO_CLEAN_OLD_DAYS = Math.max(0, parseInt(process.env.AUTO_CLEAN_OLD_DAYS || '0', 10));
// 定时清理调度器句柄与下次执行时间(供管理后台查询)
let autoCleanTimer = null;
let autoCleanNextRun = null;
// 公开房间空闲清理调度器句柄
let idleRoomTimer = null;

// 管理员配置
const ADMIN_NAME = process.env.ADMIN_NAME || 'admin';
// 可变:主管理员改密时会同步更新 .env 与内存值,保证"快速进入"与"账号登录"一致
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// 上传目录
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {}

// 客户端结构：clients.get(ws) = { name, lastSend, isAdmin, roomId }
const clients = new Map();
const nameToSockets = new Map();
// 房间 -> 该房间内的 socket 集合
const roomToSockets = new Map();
// 房间 -> 是否禁言（房间级禁言）
const roomMuted = new Map();
// IP -> 该 IP 下的 socket 集合(用于单 IP 单会话限制)
const ipToSockets = new Map();
// 被强制下线用户 -> 解禁时间戳(Infinity=永久),到期前禁止重新进入
const kickedUsers = new Map();
// IP -> 上传频率记录(用于上传限流)
const uploadRateMap = new Map();
// IP -> 注册时间戳数组(用于注册频率限制)
const registerTimes = new Map();

// 全员禁言状态
let globalMuted = false;

const DEFAULT_ROOM_ID = 'default';

// 获取客户端真实 IP(考虑 Cloudflare Tunnel 反向代理)
function getClientIp(req) {
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp) return String(cfIp).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
function addSocketToIp(ip, socket) {
  if (!ipToSockets.has(ip)) ipToSockets.set(ip, new Set());
  ipToSockets.get(ip).add(socket);
}
function removeSocketFromIp(ip, socket) {
  const set = ipToSockets.get(ip);
  if (set) { set.delete(socket); if (set.size === 0) ipToSockets.delete(ip); }
}

// ============ 限流函数 ============
// 检查单 IP 连接数限制(超过返回 false)
function checkIpConnectionLimit(ip) {
  if (!ip || ip === 'unknown') return true;
  const set = ipToSockets.get(ip);
  return !set || set.size < MAX_CONNECTIONS_PER_IP;
}
// 滑动窗口限流:检查最近 windowMs 内的消息数
// msgTimes: 时间戳数组(会被原地修改), now: 当前时间, limit: 上限, windowMs: 窗口时长
// 返回 true 表示放行,false 表示被限流
function slidingWindowRateLimit(msgTimes, now, limit, windowMs) {
  // 移除窗口外的时间戳
  const cutoff = now - windowMs;
  while (msgTimes.length > 0 && msgTimes[0] < cutoff) msgTimes.shift();
  if (msgTimes.length >= limit) return false;
  msgTimes.push(now);
  return true;
}
// 发送限流提示给客户端
function sendRateLimitedNotice(socket, reason) {
  try {
    socket.send(JSON.stringify({ type: 'rate_limited', reason: reason || '发送过于频繁,请稍后再试' }));
  } catch (e) {}
}
// 检查注册频率限制:同一 IP 10 分钟内最多 3 次,24 小时内最多 10 次(防止批量注册)
// 返回 { ok:true } 或 { ok:false, text:'错误提示' }
function checkRegisterRate(ip, now) {
  if (!ip || ip === 'unknown') return { ok: true };
  const cutoff = now - REGISTER_DAILY_WINDOW_MS;
  const arr = (registerTimes.get(ip) || []).filter(t => t >= cutoff);
  registerTimes.set(ip, arr); // 顺手清理过期记录,避免内存增长
  const shortCut = now - REGISTER_RATE_WINDOW_MS;
  const shortCount = arr.filter(t => t >= shortCut).length;
  if (shortCount >= REGISTER_RATE_LIMIT) {
    return { ok: false, text: '注册过于频繁,请 ' + Math.ceil(REGISTER_RATE_WINDOW_MS / 60000) + ' 分钟后再试' };
  }
  if (arr.length >= REGISTER_DAILY_LIMIT) {
    return { ok: false, text: '同一网络注册账号过多,请明天再试' };
  }
  return { ok: true };
}

function addSocketToName(name, socket) {
  if (!nameToSockets.has(name)) nameToSockets.set(name, new Set());
  nameToSockets.get(name).add(socket);
}
function removeSocketFromName(name, socket) {
  const set = nameToSockets.get(name);
  if (set) { set.delete(socket); if (set.size === 0) nameToSockets.delete(name); }
}
// 清理指定昵称下已失效(非 OPEN)的僵尸连接,避免断网/关机残留占用导致新设备登录被误拒
function purgeStaleNameSockets(name) {
  const set = nameToSockets.get(name);
  if (!set) return 0;
  let removed = 0;
  for (const s of Array.from(set)) {
    if (s.readyState !== WebSocket.OPEN) {
      set.delete(s);
      removed++;
    }
  }
  if (set.size === 0) nameToSockets.delete(name);
  return removed;
}
// 单点登录:踢掉指定昵称的所有旧连接,新连接代替旧连接。
// 同时作废旧连接的登录凭据(session),避免旧设备刷新后 token 自动登录造成循环互踢。
async function kickSameNameSockets(name, isSuperAdmin) {
  const existing = nameToSockets.get(name);
  if (!existing || existing.size === 0) return;
  for (const s of Array.from(existing)) {
    const info = clients.get(s);
    let reason;
    if (isSuperAdmin) reason = '主管理员在另一处登录';
    else if (info && !info.isRegistered) reason = '该昵称已被注册用户使用,请登录或换一个昵称';
    else reason = '该账号已在其他设备登录';
    try {
      if (info && info.token) storage.deleteSession(info.token).catch(() => {});
      console.log(`[kick] 强制下线 原因=${reason} 目标=${info && info.name ? info.name : '未知'} IP=${s._clientIp}`);
      s.send(JSON.stringify({ type: 'force_logout', reason }));
      s.close();
    } catch (e) {}
  }
}
function sendToName(name, data) {
  const set = nameToSockets.get(name);
  if (!set) return false;
  const json = JSON.stringify(data);
  let delivered = 0;
  for (const s of set) {
    if (s.readyState === WebSocket.OPEN) { s.send(json); delivered++; }
  }
  return delivered > 0;
}

// ============ 静态文件服务 + 上传接口 ============
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.ico': 'image/x-icon'
};
const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];

const server = http.createServer((req, res) => {
  // CORS（允许上传）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name, X-File-Mime, X-Uploader, X-Token, X-Room-Id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ---------- 文件上传接口 ----------
  if (req.method === 'POST' && req.url === '/upload') {
    // 上传频率限制(按 IP)
    const uploadIp = getClientIp(req);
    const now = Date.now();
    if (!uploadRateMap.has(uploadIp)) uploadRateMap.set(uploadIp, { last: 0, count: 0, windowStart: now });
    const ur = uploadRateMap.get(uploadIp);
    // 每分钟最多 10 次上传
    if (now - ur.windowStart > 60000) { ur.windowStart = now; ur.count = 0; }
    if (ur.count >= 10) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '上传过于频繁,每分钟最多 10 次' }));
      return;
    }
    if (now - ur.last < UPLOAD_RATE_LIMIT_MS) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '上传过快,请间隔 ' + (UPLOAD_RATE_LIMIT_MS/1000) + ' 秒' }));
      return;
    }
    ur.last = now; ur.count++;
    const fileName = (req.headers['x-file-name'] || 'file').toString().slice(0, 255);
    const fileMime = (req.headers['x-file-mime'] || 'application/octet-stream').toString().slice(0, 128);
    // 上传者身份(可追溯):昵称 + Token(注册用户)+ 来源房间
    const uploaderName = (req.headers['x-uploader'] || '').toString().slice(0, 64);
    const uploadToken = (req.headers['x-token'] || '').toString();
    const uploadRoomId = (req.headers['x-room-id'] || 'default').toString().slice(0, 32);
    const size = parseInt(req.headers['content-length'] || '0', 10);
    if (!size || size > MAX_UPLOAD_SIZE) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '文件过大或大小缺失，最大 50MB' }));
      return;
    }
    // 生成安全文件名
    const ext = path.extname(fileName).toLowerCase().slice(0, 10);
    const safeName = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext;
    const isImage = IMG_EXTS.includes(ext) || fileMime.startsWith('image/');
    // 解析上传者用户ID(用于可追溯)
    const resolveUploaderId = async () => {
      if (!uploadToken) return null;
      try {
        const u = await storage.verifyToken(uploadToken);
        return u ? u.id : null;
      } catch (e) { return null; }
    };

    if (r2.isR2Enabled()) {
      // ---- R2 模式:收集文件到 Buffer 再上传到 R2 ----
      const chunks = [];
      let total = 0;
      req.on('data', chunk => { total += chunk.length; chunks.push(chunk); });
      req.on('end', async () => {
        try {
          const buffer = Buffer.concat(chunks);
          const fileUrl = await r2.uploadToR2(safeName, buffer, fileMime);
          const userId = await resolveUploaderId();
          await storage.recordUpload({
            file_name: fileName, file_url: fileUrl,
            uploader: uploaderName, user_id: userId, ip: uploadIp,
            size: total, mime: fileMime, is_image: isImage, room_id: uploadRoomId
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            url: fileUrl,
            name: fileName,
            size: total,
            mime: fileMime,
            is_image: isImage
          }));
        } catch (e) {
          console.error('[R2] 上传失败:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '文件上传失败: ' + e.message }));
        }
      });
      req.on('error', () => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '接收数据失败' }));
      });
    } else {
      // ---- 本地模式:fallback 到本地文件系统 ----
      const fullPath = path.join(UPLOAD_DIR, safeName);
      const out = fs.createWriteStream(fullPath);
      let total = 0;
      req.on('data', chunk => { total += chunk.length; });
      req.pipe(out);
      out.on('finish', async () => {
        const userId = await resolveUploaderId();
        await storage.recordUpload({
          file_name: fileName, file_url: '/uploads/' + safeName,
          uploader: uploaderName, user_id: userId, ip: uploadIp,
          size: total, mime: fileMime, is_image: isImage, room_id: uploadRoomId
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          url: '/uploads/' + safeName,
          name: fileName,
          size: total,
          mime: fileMime,
          is_image: isImage
        }));
      });
      out.on('error', () => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '保存失败' }));
      });
    }
    return;
  }

  // ---------- 静态文件 ----------
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const publicDir = path.join(__dirname, 'public');
  const fullPath = path.join(publicDir, urlPath);
  if (!fullPath.startsWith(publicDir)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ============ WebSocket 服务 ============
const wss = new WebSocketServer({ server });

function broadcast(data, except) {
  const json = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client === except) continue;
    if (client.readyState === WebSocket.OPEN) client.send(json);
  }
}
function onlineCount() {
  let n = 0;
  for (const info of clients.values()) if (info && info.name) n++;
  return n;
}
function onlineUsers() {
  const arr = [];
  for (const info of clients.values()) if (info && info.name) arr.push(info.name);
  return arr;
}
function broadcastUserList() {
  const users = onlineUsers();
  broadcast({ type: 'user_list', users: users, count: users.length });
}

// ============ 房间相关辅助函数 ============
// 将 socket 加入指定房间
function addSocketToRoom(roomId, socket) {
  if (!roomToSockets.has(roomId)) roomToSockets.set(roomId, new Set());
  roomToSockets.get(roomId).add(socket);
}
// 将 socket 从指定房间移除
function removeSocketFromRoom(roomId, socket) {
  const set = roomToSockets.get(roomId);
  if (set) { set.delete(socket); if (set.size === 0) roomToSockets.delete(roomId); }
}
// 向房间内所有成员广播（可排除某个 socket）
function broadcastToRoom(roomId, data, except) {
  const set = roomToSockets.get(roomId);
  if (!set) return;
  const json = JSON.stringify(data);
  for (const s of set) {
    if (s === except) continue;
    if (s.readyState === WebSocket.OPEN) s.send(json);
  }
}
// 房间在线人数
function roomOnlineCount(roomId) {
  const set = roomToSockets.get(roomId);
  return set ? set.size : 0;
}
// 房间在线用户名列表（去重）
function roomOnlineUsers(roomId) {
  const set = roomToSockets.get(roomId);
  if (!set) return [];
  const names = new Set();
  for (const s of set) {
    const info = clients.get(s);
    if (info && info.name) names.add(info.name);
  }
  return Array.from(names);
}
// 广播房间用户列表给房间成员
function broadcastRoomUserList(roomId) {
  const users = roomOnlineUsers(roomId);
  broadcastToRoom(roomId, {
    type: 'room_user_list', room_id: roomId,
    users: users, count: users.length
  });
}
// 判断用户在指定房间是否为房主或全局管理员
function isRoomOwnerOrAdmin(userInfo, room) {
  if (!userInfo || !room) return false;
  if (userInfo.isAdmin) return true;
  return room.owner === userInfo.name;
}
// 是否房间"管理"成员(头衔,权限低于房主/管理员)
function isRoomManager(userInfo, room) {
  if (!userInfo || !room) return false;
  return Array.isArray(room.managers) && room.managers.includes(userInfo.name);
}

// 同步公开房间的空闲标记:房间无人在线时记录 empty_since,有人时清除
// 仅对配置了空闲超时(idle_timeout_hours)的公开房间生效
async function syncRoomIdleState(roomId) {
  try {
    if (!roomId || roomId === DEFAULT_ROOM_ID) return;
    if (roomOnlineCount(roomId) > 0) {
      await storage.updateRoomEmptySince(roomId, null);
    } else {
      const room = await storage.getRoom(roomId);
      if (room && !room.is_private && room.idle_timeout_hours) {
        await storage.updateRoomEmptySince(roomId, Date.now());
      }
    }
  } catch (e) {
    console.error('[room-idle] 同步空闲状态失败:', roomId, e.message);
  }
}

// 根据引用 id 找引用快照（group 时 roomId 用于按房间过滤历史）
async function findQuoteSnapshot(scope, userA, userB, quoteId, roomId) {
  if (!quoteId) return null;
  const hist = scope === 'group'
    ? await storage.getGroupHistory(roomId || DEFAULT_ROOM_ID, MAX_MSG_LENGTH)
    : await storage.getPrivateHistory(userA, userB);
  const m = hist.find(x => String(x.id) === String(quoteId));
  if (m) {
    return {
      id: m.id,
      sender: m.sender,
      content: String(m.content || (m.file ? m.file.name : '')).slice(0, MAX_QUOTE_LENGTH)
    };
  }
  return null;
}

// 判断昵称是否管理员
function isAdminName(name) {
  return !!ADMIN_PASSWORD && name === ADMIN_NAME;
}

// 检查用户是否处于强制下线禁令期内;返回剩余毫秒(Infinity=永久,0=未禁/已解禁)
function checkKickedBan(name) {
  const until = kickedUsers.get(name);
  if (until === undefined) return 0;
  if (until === Infinity) return Infinity;
  if (until > Date.now()) return until - Date.now();
  kickedUsers.delete(name); // 到期自动解禁
  return 0;
}
// 将分钟数(可小数)格式化为友好提示,如 0.5 -> "30 秒"
function formatKickDuration(minutes) {
  if (minutes <= 0) return '永久';
  const ms = minutes * 60000;
  if (ms < 60000) return Math.round(ms / 1000) + ' 秒';
  if (ms % 60000 === 0) return minutes + ' 分钟';
  return (Math.round(minutes * 100) / 100) + ' 分钟';
}

// 主管理员改密时同步 .env 中的 ADMIN_PASSWORD,并更新内存值
function updateEnvAdminPassword(newPassword) {
  const envFile = path.join(__dirname, '.env');
  try {
    let content = fs.readFileSync(envFile, 'utf8');
    const lineRe = /^ADMIN_PASSWORD\s*=.*$/m;
    if (lineRe.test(content)) {
      content = content.replace(lineRe, 'ADMIN_PASSWORD=' + newPassword);
    } else {
      content = content.replace(/\s*$/, '') + '\nADMIN_PASSWORD=' + newPassword + '\n';
    }
    fs.writeFileSync(envFile, content, 'utf8');
    ADMIN_PASSWORD = newPassword;
    return true;
  } catch (e) {
    console.error('[server] 同步 .env 中主管理员密码失败:', e.message);
    return false;
  }
}

// ============ 定时清理：每天固定时刻自动清理孤儿文件 ============
// 计算到下一个目标时刻(每天 AUTO_CLEAN_HOUR 点)的延迟(毫秒)
function computeNextCleanDelay() {
  const now = new Date();
  const target = new Date(now);
  target.setHours(AUTO_CLEAN_HOUR, 0, 0, 0);
  // 如果今天已过目标时刻,则延到明天
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

// 通知所有在线管理员:历史已失效,需要重新拉取
// affectedRoomIds: 受影响的房间 ID 数组(空数组表示全部房间)
// affectedPrivatePeers: 受影响的私聊对(空数组表示全部私聊)
function notifyHistoryInvalidated(affectedRoomIds, affectedPrivatePeers) {
  const payload = JSON.stringify({
    type: 'history_invalidated',
    room_ids: affectedRoomIds || [],
    private_peers: affectedPrivatePeers || []
  });
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const info = clients.get(client);
    if (!info || !info.name) continue;
    client.send(payload);
  }
}

// 通知所有在线管理员:清理完成(用于刷新统计)
function notifyAdminsCleanDone(summary) {
  const payload = JSON.stringify({
    type: 'admin_auto_clean_done',
    summary
  });
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const info = clients.get(client);
    if (info && info.isAdmin) client.send(payload);
  }
}

// 执行一次自动清理(撤回消息+孤儿文件,可选清理旧消息)
// source: 'auto' (定时触发) 或 'manual' (手动触发,仅用于日志)
async function runAutoClean(source) {
  source = source || 'auto';
  try {
    console.log(`[clean] ${source} 清理开始 (${new Date().toISOString()})`);
    const revokedResult = await storage.cleanRevokedAndOrphans();
    let oldResult = null;
    if (AUTO_CLEAN_OLD_DAYS > 0) {
      oldResult = await storage.cleanOldMessages(AUTO_CLEAN_OLD_DAYS);
    }
    const summary = {
      source,
      time: Date.now(),
      revoked: revokedResult,
      old_messages: oldResult
    };
    console.log(`[clean] ${source} 清理完成:`, JSON.stringify(summary));
    // 通知所有在线管理员刷新统计
    notifyAdminsCleanDone(summary);
    // 受影响范围:旧消息清理时所有房间和私聊历史都可能变化,统一通知全量刷新
    notifyHistoryInvalidated([], []);
    return summary;
  } catch (e) {
    console.error(`[clean] ${source} 清理失败:`, e.message);
    return { source, time: Date.now(), error: e.message };
  }
}

// 启动定时清理调度器:每天 AUTO_CLEAN_HOUR 点执行一次
function startAutoCleanScheduler() {
  if (!AUTO_CLEAN_ENABLED) {
    console.log(`[clean] 自动清理已禁用 (AUTO_CLEAN_ENABLED=0)`);
    return;
  }
  const delay = computeNextCleanDelay();
  autoCleanNextRun = Date.now() + delay;
  console.log(`[clean] 自动清理已启用,下次执行: ${new Date(autoCleanNextRun).toLocaleString('zh-CN')} (每天 ${AUTO_CLEAN_HOUR}:00)${AUTO_CLEAN_OLD_DAYS > 0 ? `,同时清理 ${AUTO_CLEAN_OLD_DAYS} 天前的旧消息` : ''}`);
  // 第一次:延迟到目标时刻
  autoCleanTimer = setTimeout(function run() {
    runAutoClean('auto');
    // 后续:每 24 小时一次
    autoCleanTimer = setInterval(() => runAutoClean('auto'), 24 * 60 * 60 * 1000);
    // 更新下次执行时间(24小时后)
    autoCleanNextRun = Date.now() + 24 * 60 * 60 * 1000;
    // 替换 autoCleanTimer 句柄(从 setTimeout 切到 setInterval)
  }, delay);
}

// ============ 公开房间空闲自动清理 ============
// 定期扫描:删除配置了空闲超时且已到期的公开房间
const ROOM_IDLE_CHECK_MS = 5 * 60 * 1000; // 每 5 分钟扫描一次

// 清理单个到期房间:把成员踢回 default → 删除房间 → 通知所有客户端刷新
async function cleanupExpiredPublicRoom(room) {
  const roomId = room.id;
  // 再次确认确实无人(防止扫描期间有人刚加入)
  if (roomOnlineCount(roomId) > 0) return;
  const set = roomToSockets.get(roomId);
  if (set) {
    const members = Array.from(set);
    for (const s of members) {
      removeSocketFromRoom(roomId, s);
      const sInfo = clients.get(s);
      if (sInfo) {
        sInfo.roomIds.delete(roomId);
        if (sInfo.activeRoomId === roomId) {
          sInfo.activeRoomId = DEFAULT_ROOM_ID;
          addSocketToRoom(DEFAULT_ROOM_ID, s);
          sInfo.roomIds.add(DEFAULT_ROOM_ID);
          const defRoom = await storage.getRoom(DEFAULT_ROOM_ID);
          s.send(JSON.stringify({
            type: 'room_joined', room: defRoom, history: [],
            room_muted: !!roomMuted.get(DEFAULT_ROOM_ID), forced: true
          }));
          s.send(JSON.stringify({ type: 'notice', text: '房间 "' + room.name + '" 因长时间无人使用已被自动清理' }));
        }
      }
    }
  }
  await storage.deleteRoom(roomId);
  roomMuted.delete(roomId);
  // 通知所有客户端:房间已被删除(刷新房间列表/侧边栏)
  broadcast({ type: 'room_deleted', room_id: roomId, reason: 'idle' });
  console.log(`[room-idle] 已删除空闲超时房间: ${room.name} (${roomId})`);
}

// 启动空闲房间扫描调度器
function startIdleRoomScheduler() {
  idleRoomTimer = setInterval(async () => {
    try {
      const expired = await storage.listExpiredPublicRooms(Date.now());
      if (expired.length === 0) return;
      console.log(`[room-idle] 发现 ${expired.length} 个空闲超时房间,开始清理`);
      for (const room of expired) {
        await cleanupExpiredPublicRoom(room);
      }
    } catch (e) {
      console.error('[room-idle] 扫描空闲房间失败:', e.message);
    }
  }, ROOM_IDLE_CHECK_MS);
}

// 公共进入流程:完成身份建立、加入 default 房间、发送历史与上线广播
// identity: { name, isAdmin, isSuperAdmin, isRegistered, userId, token }
async function completeEntrance(socket, identity) {
  const { name, isAdmin, isSuperAdmin, isRegistered, userId, token } = identity;
  // 强制下线禁令检查:到期前禁止重新进入
  const banLeft = checkKickedBan(name);
  if (banLeft !== 0) {
    const minutes = banLeft === Infinity ? 0 : Math.round(banLeft / 60000 * 100) / 100;
    socket.send(JSON.stringify({
      type: 'kicked', by: 'system', duration_minutes: minutes,
      until: banLeft === Infinity ? 0 : Date.now() + banLeft,
      reason: banLeft === Infinity
        ? '你已被管理员强制下线（永久禁止进入）'
        : '你已被管理员强制下线，' + formatKickDuration(minutes) + '后可重新进入'
    }));
    socket.close();
    return false;
  }
  try {
    const userInfo = {
      name, lastSend: 0,
      isAdmin: !!isAdmin,
      isSuperAdmin: !!isSuperAdmin,
      isRegistered: !!isRegistered,
      userId: userId || null,
      token: token || null,
      // 多房间:已加入的所有房间 ID 集合(含 default)
      roomIds: new Set([DEFAULT_ROOM_ID]),
      // 当前查看的房间 ID(用于兼容旧逻辑,前端切换会话时由 msg.room_id 指定)
      activeRoomId: DEFAULT_ROOM_ID,
      // 限流:消息时间戳记录
      msgTimes: [],        // 滑动窗口(MSG_WINDOW_MS 内 MSG_WINDOW_LIMIT 条)
      msgTimesMin: [],     // 每分钟窗口(MSG_PER_MINUTE_LIMIT 条)
      lastUpload: 0        // 上传时间戳
    };
    clients.set(socket, userInfo);
    addSocketToName(name, socket);
    addSocketToRoom(DEFAULT_ROOM_ID, socket);
    // 登记 IP 到连接数统计表(仅用于单 IP 连接数上限,不再按 IP 互踢——避免同一 NAT 下多设备误伤)
    const ip = socket._clientIp;
    if (ip) {
      addSocketToIp(ip, socket);
    }
    const role = userInfo.isSuperAdmin ? '主管理员' : userInfo.isAdmin ? '管理员' : userInfo.isRegistered ? '注册用户' : '临时用户';
    console.log(`[conn] 用户进入 name=${name} IP=${ip} 身份=${role}`);
    const count = onlineCount();
    const defaultRoom = await storage.getRoom(DEFAULT_ROOM_ID);
    socket.send(JSON.stringify({
      type: 'name_set', name, count,
      is_admin: userInfo.isAdmin,
      is_super_admin: userInfo.isSuperAdmin,
      is_registered: userInfo.isRegistered,
      global_muted: globalMuted,
      current_room: defaultRoom,
      room_muted: !!roomMuted.get(DEFAULT_ROOM_ID)
    }));
    const history = await storage.getGroupHistory(DEFAULT_ROOM_ID);
    const formatted = history.map(m => ({
      id: m.id, name: m.sender, content: m.content,
      content_type: m.content_type, file: m.file, quote: m.quote,
      revoked: m.revoked, revoked_by: m.revoked_by, time: m.time, room_id: m.room_id
    }));
    socket.send(JSON.stringify({ type: 'history', data: formatted, room_id: DEFAULT_ROOM_ID }));
    // 进入即展示 default 历史,标记已读(避免历史被算作未读)
    await storage.markRoomRead(name, DEFAULT_ROOM_ID);
    broadcastToRoom(DEFAULT_ROOM_ID, { type: 'online', name, count, time: Date.now(), room_id: DEFAULT_ROOM_ID }, socket);
    broadcastRoomUserList(DEFAULT_ROOM_ID);

    // 推送该用户的私聊会话列表(含未读数),用于侧边栏预加载和离线消息提示
    try {
      const privateConvs = await storage.listPrivateConversations(name);
      if (privateConvs && privateConvs.length > 0) {
        socket.send(JSON.stringify({
          type: 'private_conversations',
          conversations: privateConvs
        }));
      }
    } catch (e) {
      console.error('[server] 拉取私聊会话列表失败:', e.message);
    }
  } catch (e) {
    // 进入流程异常:清理已登记的身份,避免昵称/IP 残留占用导致后续登录被误拒
    console.error('[server] completeEntrance 失败:', e.message);
    removeSocketFromName(name, socket);
    if (socket._clientIp) removeSocketFromIp(socket._clientIp, socket);
    clients.delete(socket);
    try { socket.close(); } catch (e2) {}
  }
}

wss.on('connection', (socket, req) => {
  let userInfo = null;

  // 记录客户端真实 IP(用于单 IP 单会话限制)
  socket._clientIp = getClientIp(req);
  console.log(`[conn] 连接建立 IP=${socket._clientIp} 当前连接数=${wss.clients.size}`);

  // ---- 全局连接数限制 ----
  if (wss.clients.size > MAX_CONNECTIONS) {
    try { socket.send(JSON.stringify({ type: 'server_full', text: '服务器连接数已满,请稍后再试' })); } catch (e) {}
    socket.close(1013, 'Too many connections');
    return;
  }
  // ---- 单 IP 连接数限制(防 DDoS) ----
  if (!DISABLE_IP_LIMIT && !checkIpConnectionLimit(socket._clientIp)) {
    try { socket.send(JSON.stringify({ type: 'notice', text: '该 IP 连接数过多,请稍后再试' })); } catch (e) {}
    socket.close(1013, 'Too many connections from this IP');
    return;
  }

  // 心跳检测：初始化为存活，收到 pong 后恢复
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', async (raw) => {
    // ---- 单条消息字节大小限制 ----
    if (raw.length > MAX_MESSAGE_BYTES) {
      sendRateLimitedNotice(socket, '消息过大,单条最大 ' + (MAX_MESSAGE_BYTES / 1024) + 'KB');
      return;
    }
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch (e) { return; }

    // ---- 注册账号 ----
    if (msg.type === 'register') {
      try {
        // 注册频率限制(防批量注册)
        const regRate = checkRegisterRate(socket._clientIp, Date.now());
        if (!regRate.ok) {
          socket.send(JSON.stringify({ type: 'register_result', ok: false, error: regRate.text }));
          return;
        }
        const user = await storage.registerUser({
          username: msg.username,
          nickname: msg.nickname,
          password: msg.password
        });
        // 注册成功,记录注册时间用于频率统计
        const regArr = registerTimes.get(socket._clientIp) || [];
        regArr.push(Date.now());
        registerTimes.set(socket._clientIp, regArr);
        // 注册成功,自动登录
        const token = await storage.createSession(user.id, msg.remember !== false);
        socket.send(JSON.stringify({
          type: 'register_result', ok: true,
          token, name: user.nickname,
          user_id: user.id, is_admin: false, is_super_admin: false
        }));
        // 清理已失效的同名连接,并踢掉占用该昵称的临时用户(避免双连接共存)
        purgeStaleNameSockets(user.nickname);
        const dup = nameToSockets.get(user.nickname);
        if (dup && dup.size > 0) {
          for (const s of Array.from(dup)) {
            const info = clients.get(s);
            if (info && !info.isRegistered) {
              try {
                console.log(`[kick] 强制下线 原因=昵称已被注册 目标=${info.name} IP=${s._clientIp}`);
                s.send(JSON.stringify({ type: 'force_logout', reason: '该昵称已被注册,请登录或换一个昵称' }));
                s.close();
              } catch (e) {}
            }
          }
        }
        await completeEntrance(socket, {
          name: user.nickname, isAdmin: false, isSuperAdmin: false,
          isRegistered: true, userId: user.id, token
        });
        userInfo = clients.get(socket);
      } catch (e) {
        socket.send(JSON.stringify({ type: 'register_result', ok: false, error: e.message }));
      }
      return;
    }

    // ---- 登录(用户名+密码 或 token) ----
    if (msg.type === 'login') {
      let user = null;
      let sessionToken = null;
      if (msg.token) {
        // token 自动登录
        user = await storage.verifyToken(msg.token);
        if (!user) {
          socket.send(JSON.stringify({ type: 'login_result', ok: false, error: '登录已过期,请重新登录' }));
          return;
        }
        sessionToken = msg.token;
      } else if (msg.username) {
        // 用户名+密码登录
        user = await storage.loginUser({ username: msg.username, password: msg.password });
        if (!user) {
          socket.send(JSON.stringify({ type: 'login_result', ok: false, error: '用户名或密码错误' }));
          return;
        }
        // 主管理员(如 jie)已注册为账户,通过账号登录同样按超管处理
        // 登录成功,创建 session
        sessionToken = await storage.createSession(user.id, msg.remember !== false);
      } else {
        socket.send(JSON.stringify({ type: 'login_result', ok: false, error: '参数缺失' }));
        return;
      }
      // 主管理员身份判定(覆盖 token 自动登录路径)
      const isSuperAdmin = !!ADMIN_PASSWORD && (user.username === ADMIN_NAME || isAdminName(user.nickname));
      const isAdmin = !!user.is_admin || isSuperAdmin;
      // 清理已失效的同名连接(断网/关机残留),避免新设备登录被误拒
      purgeStaleNameSockets(user.nickname);
      // 单点登录:新连接顶掉旧的同名连接(其他设备的同账号 / 同名临时用户)
      await kickSameNameSockets(user.nickname, isSuperAdmin);
      // 占用检查通过后才返回成功(避免先 ok:true 后 ok:false 的双响应)
      socket.send(JSON.stringify({
        type: 'login_result', ok: true, token: sessionToken,
        name: user.nickname, user_id: user.id,
        is_admin: isAdmin, is_super_admin: isSuperAdmin,
        just_logged_in: true
      }));
      await completeEntrance(socket, {
        name: user.nickname, isAdmin, isSuperAdmin,
        isRegistered: true, userId: user.id, token: sessionToken
      });
      userInfo = clients.get(socket);
      return;
    }

    // ---- 设置昵称(临时用户 或 主管理员) ----
    if (msg.type === 'set_name') {
      const name = String(msg.name || '').slice(0, MAX_NAME_LENGTH).trim();
      if (!name) return;
      // 判断管理员身份：仅主管理员通过 set_name 登录
      let isAdmin = false;
      let isSuperAdmin = false;
      if (isAdminName(name)) {
        // 主管理员昵称
        if (ADMIN_PASSWORD && msg.password === ADMIN_PASSWORD) {
          isAdmin = true; isSuperAdmin = true;
        } else {
          // 密码错误,保护主管理员昵称
          socket.send(JSON.stringify({
            type: 'name_error',
            text: '该昵称为保留昵称,请换一个昵称'
          }));
          return;
        }
      } else {
        // 普通昵称:检查是否被注册用户占用
        const registeredUser = await storage.getUserByNickname(name);
        if (registeredUser) {
          socket.send(JSON.stringify({
            type: 'name_error',
            text: '该昵称已注册,请登录或换一个昵称'
          }));
          return;
        }
      }
      // 清理已失效的同名连接(断网/关机残留)
      purgeStaleNameSockets(name);
      // 昵称占用检查：同名已存在活跃连接则拒绝
      // 例外:主管理员登录时踢掉旧的同名连接(单点登录)
      const existing = nameToSockets.get(name);
      if (existing && existing.size > 0) {
        if (isSuperAdmin) {
          // 主管理员顶号:踢掉旧连接并作废其 session
          await kickSameNameSockets(name, true);
        } else {
          socket.send(JSON.stringify({
            type: 'name_error',
            text: '该昵称已被使用,请换一个昵称'
          }));
          return;
        }
      }
      await completeEntrance(socket, {
        name, isAdmin, isSuperAdmin,
        isRegistered: false, userId: null
      });
      userInfo = clients.get(socket);
      return;
    }

    if (!userInfo) {
      // 入口(completeEntrance)可能尚未完全结束,但 clients 中已登记身份;
      // 此时若已登记,直接用其身份处理消息,避免登录后立即操作被静默丢弃
      userInfo = clients.get(socket);
      if (!userInfo) return;
    }

    // ---- 列出所有房间 ----
    if (msg.type === 'list_rooms') {
      const rooms = await storage.listRooms();
      // 附加每个房间的在线人数
      rooms.forEach(r => { r.online = roomOnlineCount(r.id); });
      socket.send(JSON.stringify({ type: 'room_list', data: rooms }));
      return;
    }

    // ---- 查看指定房间的在线用户列表(切换会话时刷新) ----
    if (msg.type === 'view_room_users') {
      const roomId = String(msg.room_id || '').slice(0, 32).trim();
      if (!roomId) return;
      const users = roomOnlineUsers(roomId);
      socket.send(JSON.stringify({
        type: 'room_user_list', room_id: roomId, users, count: users.length
      }));
      return;
    }

    // ---- 创建房间 ----
    if (msg.type === 'create_room') {
      console.log('[debug] create_room received, userInfo=', userInfo ? userInfo.name : 'null');
      const name = String(msg.name || '').slice(0, 64).trim();
      if (!name) {
        socket.send(JSON.stringify({ type: 'notice', text: '房间名不能为空' }));
        return;
      }
      try {
        const room = await storage.createRoom({
          name,
          password: msg.password || '',
          owner: userInfo.name,
          isPrivate: !!msg.is_private,
          idleTimeoutHours: msg.idle_timeout_hours
        });
        console.log('[debug] create_room success, room.id=', room.id);
        socket.send(JSON.stringify({ type: 'room_created', room }));
      } catch (e) {
        console.log('[debug] create_room error:', e.message);
        socket.send(JSON.stringify({ type: 'notice', text: '创建房间失败：' + e.message }));
      }
      return;
    }

    // ---- 加入房间(多房间模式:不离开旧房间,追加加入) ----
    if (msg.type === 'join_room') {
      const roomId = String(msg.room_id || '').slice(0, 32).trim();
      // silent:重连自动恢复时静默,失败不打扰用户(房间可能已删除或需要密码)
      const silent = !!msg.silent;
      const sendError = (text) => { if (!silent) socket.send(JSON.stringify({ type: 'room_error', text })); };
      if (!roomId) return;
      const room = await storage.getRoom(roomId);
      if (!room) {
        sendError('房间不存在');
        return;
      }
      // 校验密码
      const verify = await storage.verifyRoomPassword(roomId, msg.password || '');
      if (!verify.exists) {
        sendError('房间不存在');
        return;
      }
      if (!verify.ok) {
        sendError('密码错误');
        return;
      }
      // 已加入过该房间:仅切换查看,不重复加入
      if (userInfo.roomIds && userInfo.roomIds.has(roomId)) {
        userInfo.activeRoomId = roomId;
        socket.send(JSON.stringify({
          type: 'room_joined', room, history: [],
          room_muted: !!roomMuted.get(roomId), already_joined: true
        }));
        return;
      }
      // 加入新房间(不离开旧房间)
      addSocketToRoom(roomId, socket);
      userInfo.roomIds.add(roomId);
      userInfo.activeRoomId = roomId;
      // 注册用户:持久化已加入房间(退出登录/换设备后恢复)
      if (userInfo.userId) {
        storage.addUserRoom(userInfo.userId, roomId).catch(() => {});
      }
      // 首次加入(非 silent 恢复)即视为已读(该房间历史不产生未读)
      // silent 恢复时保留之前的未读状态
      if (!silent) {
        storage.markRoomRead(userInfo.name, roomId).catch(() => {});
      }
      syncRoomIdleState(roomId); // 有人进入,清除空闲标记
      const history = await storage.getGroupHistory(roomId);
      const formatted = history.map(m => ({
        id: m.id, name: m.sender, content: m.content,
        content_type: m.content_type, file: m.file, quote: m.quote,
        revoked: m.revoked, revoked_by: m.revoked_by, time: m.time, room_id: m.room_id
      }));
      socket.send(JSON.stringify({
        type: 'room_joined', room, history: formatted,
        room_muted: !!roomMuted.get(roomId), silent: !!silent
      }));
      // 通知新房间该用户上线
      broadcastToRoom(roomId, { type: 'online', name: userInfo.name, time: Date.now(), room_id: roomId }, socket);
      broadcastRoomUserList(roomId);
      return;
    }

    // ---- 重新拉取指定房间的历史(用于 history_invalidated 后刷新) ----
    if (msg.type === 'get_room_history') {
      const roomId = String(msg.room_id || '').slice(0, 32).trim();
      if (!roomId) return;
      // 仅允许拉取已加入的房间
      if (!userInfo.roomIds || !userInfo.roomIds.has(roomId)) {
        socket.send(JSON.stringify({ type: 'room_error', text: '未加入该房间' }));
        return;
      }
      const history = await storage.getGroupHistory(roomId);
      const formatted = history.map(m => ({
        id: m.id, name: m.sender, content: m.content,
        content_type: m.content_type, file: m.file, quote: m.quote,
        revoked: m.revoked, revoked_by: m.revoked_by, time: m.time, room_id: m.room_id
      }));
      socket.send(JSON.stringify({ type: 'history', data: formatted, room_id: roomId }));
      return;
    }

    // ---- 重新拉取指定私聊的历史(用于 history_invalidated 后刷新) ----
    if (msg.type === 'get_private_history') {
      const peer = String(msg.peer || '').slice(0, 64).trim();
      if (!peer) return;
      const history = await storage.getPrivateHistory(userInfo.name, peer);
      const formatted = history.map(m => ({
        id: m.id, name: m.sender, content: m.content,
        content_type: m.content_type, file: m.file, quote: m.quote,
        revoked: m.revoked, revoked_by: m.revoked_by, time: m.time
      }));
      socket.send(JSON.stringify({ type: 'private_history', peer, data: formatted }));
      // 标记该会话已读(清未读数)
      storage.markPrivateRead(userInfo.name, peer).catch(() => {});
      return;
    }

    // ---- 标记私聊会话已读(用户打开/切到某个私聊时) ----
    if (msg.type === 'mark_private_read') {
      const peer = String(msg.peer || '').slice(0, 64).trim();
      if (!peer) return;
      storage.markPrivateRead(userInfo.name, peer).catch(() => {});
      return;
    }

    // ---- 离开房间(从指定房间移除,不能离开 default) ----
    if (msg.type === 'leave_room') {
      const roomId = String(msg.room_id || '').slice(0, 32).trim();
      if (!roomId || roomId === DEFAULT_ROOM_ID) {
        socket.send(JSON.stringify({ type: 'notice', text: '不能离开默认房间' }));
        return;
      }
      if (!userInfo.roomIds || !userInfo.roomIds.has(roomId)) {
        socket.send(JSON.stringify({ type: 'notice', text: '未加入该房间' }));
        return;
      }
      // 从该房间移除
      removeSocketFromRoom(roomId, socket);
      userInfo.roomIds.delete(roomId);
      // 注册用户:取消持久化的已加入房间
      if (userInfo.userId) {
        storage.removeUserRoom(userInfo.userId, roomId).catch(() => {});
      }
      syncRoomIdleState(roomId); // 可能变空,同步空闲标记
      broadcastToRoom(roomId, { type: 'offline', name: userInfo.name, time: Date.now(), room_id: roomId });
      broadcastRoomUserList(roomId);
      socket.send(JSON.stringify({ type: 'room_left', room_id: roomId }));
      // 若离开的是当前查看的房间,切回 default
      if (userInfo.activeRoomId === roomId) {
        userInfo.activeRoomId = DEFAULT_ROOM_ID;
      }
      return;
    }

    // ---- 查询已加入的房间列表 ----
    if (msg.type === 'joined_rooms') {
      const joinedList = [];
      const seen = new Set();
      if (userInfo.roomIds) {
        for (const rid of userInfo.roomIds) {
          const r = await storage.getRoom(rid);
          if (r) { joinedList.push(r); seen.add(rid); }
        }
      }
      // 注册用户:合并持久化的已加入房间(退出登录/换设备后重新登录恢复)
      if (userInfo.userId) {
        const savedRids = await storage.getUserJoinedRooms(userInfo.userId);
        for (const rid of savedRids) {
          if (seen.has(rid)) continue;
          const r = await storage.getRoom(rid);
          if (r) { joinedList.push(r); seen.add(rid); }
        }
      }
      // 计算各房间未读数(仅对已加入的房间)
      const roomIds = joinedList.map(r => r.id);
      const unreads = await storage.listRoomUnreads(userInfo.name, roomIds);
      joinedList.forEach(r => { r.unread = unreads[r.id] || 0; });
      socket.send(JSON.stringify({ type: 'joined_rooms', data: joinedList }));
      return;
    }

    // ---- 标记房间已读(用户切换到该房间时) ----
    if (msg.type === 'mark_room_read') {
      const roomId = String(msg.room_id || '').slice(0, 32).trim();
      if (roomId && userInfo.name) {
        storage.markRoomRead(userInfo.name, roomId).catch(() => {});
      }
      return;
    }

    // ---- 转让房主 ----
    if (msg.type === 'transfer_owner') {
      const roomId = String(msg.room_id || '').slice(0, 32).trim();
      const newOwner = String(msg.new_owner || '').slice(0, 64).trim();
      if (!roomId || !newOwner) return;
      const room = await storage.getRoom(roomId);
      if (!room) {
        socket.send(JSON.stringify({ type: 'notice', text: '房间不存在' }));
        return;
      }
      if (!isRoomOwnerOrAdmin(userInfo, room)) {
        socket.send(JSON.stringify({ type: 'notice', text: '无权操作：仅房主或管理员可转让' }));
        return;
      }
      // 公共大厅不可转让房主(避免误操作)
      if (roomId === DEFAULT_ROOM_ID) {
        socket.send(JSON.stringify({ type: 'notice', text: '公共大厅不支持转让房主' }));
        return;
      }
      // 新房主必须在线
      if (!nameToSockets.has(newOwner)) {
        socket.send(JSON.stringify({ type: 'notice', text: '新房主不在线' }));
        return;
      }
      const ok = await storage.transferOwner(roomId, newOwner);
      if (ok) {
        broadcastToRoom(roomId, { type: 'owner_transferred', room_id: roomId, new_owner: newOwner, by: userInfo.name });
      } else {
        socket.send(JSON.stringify({ type: 'notice', text: '转让失败' }));
      }
      return;
    }

    // ---- 删除房间 ----
    if (msg.type === 'delete_room') {
      const roomId = String(msg.room_id || '').slice(0, 32).trim();
      if (!roomId) return;
      if (roomId === DEFAULT_ROOM_ID) {
        socket.send(JSON.stringify({ type: 'notice', text: '不能删除默认房间' }));
        return;
      }
      const room = await storage.getRoom(roomId);
      if (!room) {
        socket.send(JSON.stringify({ type: 'notice', text: '房间不存在' }));
        return;
      }
      if (!isRoomOwnerOrAdmin(userInfo, room)) {
        socket.send(JSON.stringify({ type: 'notice', text: '无权操作：仅房主或管理员可删除房间' }));
        return;
      }
      // 将房间内所有成员踢回 default
      const set = roomToSockets.get(roomId);
      if (set) {
        const members = Array.from(set);
        for (const s of members) {
          removeSocketFromRoom(roomId, s);
          const sInfo = clients.get(s);
          if (sInfo) {
            sInfo.roomId = DEFAULT_ROOM_ID;
            addSocketToRoom(DEFAULT_ROOM_ID, s);
          }
          if (s.readyState === WebSocket.OPEN) {
            s.send(JSON.stringify({ type: 'room_deleted', room_id: roomId, by: userInfo.name }));
            // 给被踢成员推送 default 房间信息与历史
            const defaultRoom = await storage.getRoom(DEFAULT_ROOM_ID);
            const dh = await storage.getGroupHistory(DEFAULT_ROOM_ID);
            const dfmt = dh.map(m => ({
              id: m.id, name: m.sender, content: m.content,
              content_type: m.content_type, file: m.file, quote: m.quote,
              revoked: m.revoked, revoked_by: m.revoked_by, time: m.time, room_id: m.room_id
            }));
            s.send(JSON.stringify({
              type: 'room_joined', room: defaultRoom, history: dfmt,
              room_muted: !!roomMuted.get(DEFAULT_ROOM_ID)
            }));
          }
        }
      }
      await storage.deleteRoom(roomId);
      roomMuted.delete(roomId);
      // 通知 default 房间有新成员加入
      broadcastRoomUserList(DEFAULT_ROOM_ID);
      return;
    }

    // ---- 更新房间设置 ----
    if (msg.type === 'update_room') {
      const roomId = String(msg.room_id || '').slice(0, 32).trim();
      if (!roomId) return;
      const room = await storage.getRoom(roomId);
      if (!room) {
        socket.send(JSON.stringify({ type: 'notice', text: '房间不存在' }));
        return;
      }
      if (!isRoomOwnerOrAdmin(userInfo, room)) {
        socket.send(JSON.stringify({ type: 'notice', text: '无权操作：仅房主或管理员可修改房间设置' }));
        return;
      }
      // 公共大厅仅可禁言,不可改名/改密/改类型(避免误操作)
      if (roomId === DEFAULT_ROOM_ID && (msg.name !== undefined || msg.password !== undefined || msg.is_private !== undefined)) {
        socket.send(JSON.stringify({ type: 'notice', text: '公共大厅不支持修改名称/密码/类型' }));
        return;
      }
      const updates = {};
      if (msg.name !== undefined) updates.name = msg.name;
      if (msg.password !== undefined) updates.password = msg.password;
      if (msg.is_private !== undefined) updates.isPrivate = msg.is_private;
      const ok = await storage.updateRoom(roomId, updates);
      if (ok) {
        const updated = await storage.getRoom(roomId);
        broadcastToRoom(roomId, { type: 'room_updated', room_id: roomId, room: updated, by: userInfo.name });
      } else {
        socket.send(JSON.stringify({ type: 'notice', text: '更新失败' }));
      }
      return;
    }

    // ---- 房间级踢人 ----
    if (msg.type === 'room_kick') {
      const roomId = String(msg.room_id || '').slice(0, 32).trim();
      const target = String(msg.name || '').slice(0, 64).trim();
      const duration = parseInt(msg.duration || '0', 10); // 秒，0=永久（仅踢出房间）
      if (!roomId || !target) return;
      const room = await storage.getRoom(roomId);
      if (!room) {
        socket.send(JSON.stringify({ type: 'notice', text: '房间不存在' }));
        return;
      }
      // 权限:房主/管理员/房间管理可踢普通成员
      if (!isRoomOwnerOrAdmin(userInfo, room) && !isRoomManager(userInfo, room)) {
        socket.send(JSON.stringify({ type: 'notice', text: '无权操作：仅房主、管理员或房间管理可踢人' }));
        return;
      }
      // 公共大厅无法"踢出"(成员始终属于大厅),请使用强制下线
      if (roomId === DEFAULT_ROOM_ID) {
        socket.send(JSON.stringify({ type: 'notice', text: '公共大厅不支持踢出,可使用强制下线' }));
        return;
      }
      // 房间"管理"权限低于房主/管理员:不能对房主、其他管理、全局管理员使用
      if (!isRoomOwnerOrAdmin(userInfo, room)) {
        if (target === room.owner) {
          socket.send(JSON.stringify({ type: 'notice', text: '无权操作:不能踢房主' }));
          return;
        }
        if (Array.isArray(room.managers) && room.managers.includes(target)) {
          socket.send(JSON.stringify({ type: 'notice', text: '无权操作:不能踢房间管理' }));
          return;
        }
        const tSet = nameToSockets.get(target);
        const tInfo = tSet && tSet.size > 0 ? clients.get(Array.from(tSet)[0]) : null;
        if (tInfo && tInfo.isAdmin) {
          socket.send(JSON.stringify({ type: 'notice', text: '无权操作:不能踢管理员' }));
          return;
        }
      }
      const until = duration > 0 ? Date.now() + duration * 1000 : 0;
      // 找到目标用户在该房间内的所有 socket
      const set = roomToSockets.get(roomId);
      if (set) {
        const targetSockets = [];
        for (const s of set) {
          const info = clients.get(s);
          if (info && info.name === target) targetSockets.push(s);
        }
        for (const s of targetSockets) {
          removeSocketFromRoom(roomId, s);
          const sInfo = clients.get(s);
          if (sInfo) {
            sInfo.roomId = DEFAULT_ROOM_ID;
            sInfo.activeRoomId = DEFAULT_ROOM_ID;
            if (sInfo.roomIds) {
              sInfo.roomIds.delete(roomId);
              sInfo.roomIds.add(DEFAULT_ROOM_ID);
            }
            addSocketToRoom(DEFAULT_ROOM_ID, s);
            // 注册用户:移除持久化的已加入房间记录(避免重登后被自动加回)
            if (sInfo.userId) {
              storage.removeUserRoom(sInfo.userId, roomId).catch(() => {});
            }
          }
          if (s.readyState === WebSocket.OPEN) {
            s.send(JSON.stringify({
              type: 'room_kicked', room_id: roomId,
              by: userInfo.name, duration, until
            }));
            const defaultRoom = await storage.getRoom(DEFAULT_ROOM_ID);
            const dh = await storage.getGroupHistory(DEFAULT_ROOM_ID);
            const dfmt = dh.map(m => ({
              id: m.id, name: m.sender, content: m.content,
              content_type: m.content_type, file: m.file, quote: m.quote,
              revoked: m.revoked, revoked_by: m.revoked_by, time: m.time, room_id: m.room_id
            }));
            s.send(JSON.stringify({
              type: 'room_joined', room: defaultRoom, history: dfmt,
              room_muted: !!roomMuted.get(DEFAULT_ROOM_ID)
            }));
          }
        }
      }
      // 通知原房间：目标已离开
      broadcastToRoom(roomId, { type: 'offline', name: target, time: Date.now(), room_id: roomId });
      broadcastRoomUserList(roomId);
      broadcastRoomUserList(DEFAULT_ROOM_ID);
      return;
    }

    // ---- 房间级禁言 ----
    if (msg.type === 'room_mute') {
      const roomId = String(msg.room_id || '').slice(0, 32).trim();
      if (!roomId) return;
      const room = await storage.getRoom(roomId);
      if (!room) {
        socket.send(JSON.stringify({ type: 'notice', text: '房间不存在' }));
        return;
      }
      if (!isRoomOwnerOrAdmin(userInfo, room) && !isRoomManager(userInfo, room)) {
        socket.send(JSON.stringify({ type: 'notice', text: '无权操作：仅房主、管理员或房间管理可设置禁言' }));
        return;
      }
      const muted = !!msg.muted;
      roomMuted.set(roomId, muted);
      broadcastToRoom(roomId, { type: 'room_mute_changed', room_id: roomId, muted, by: userInfo.name });
      return;
    }

    // ---- 设置/取消房间"管理"成员(仅房主或管理员可操作) ----
    if (msg.type === 'set_room_manager') {
      const roomId = String(msg.room_id || '').slice(0, 32).trim();
      const target = String(msg.name || '').slice(0, MAX_NAME_LENGTH).trim();
      if (!roomId || !target) return;
      const room = await storage.getRoom(roomId);
      if (!room) {
        socket.send(JSON.stringify({ type: 'notice', text: '房间不存在' }));
        return;
      }
      if (!isRoomOwnerOrAdmin(userInfo, room)) {
        socket.send(JSON.stringify({ type: 'notice', text: '无权操作:仅房主或管理员可设置房间管理' }));
        return;
      }
      const on = !!msg.on;
      if (on) {
        // 目标必须在当前房间在线
        const set = roomToSockets.get(roomId);
        let targetOnline = false;
        if (set) {
          for (const s of set) {
            const info = clients.get(s);
            if (info && info.name === target) { targetOnline = true; break; }
          }
        }
        if (!targetOnline) {
          socket.send(JSON.stringify({ type: 'notice', text: '该用户不在当前房间' }));
          return;
        }
        // 房主/管理员已拥有更高权限,无需设为管理
        if (target === room.owner) {
          socket.send(JSON.stringify({ type: 'notice', text: '房主已是最高权限,无需设置' }));
          return;
        }
        const tSet = nameToSockets.get(target);
        const tInfo = tSet && tSet.size > 0 ? clients.get(Array.from(tSet)[0]) : null;
        if (tInfo && tInfo.isAdmin) {
          socket.send(JSON.stringify({ type: 'notice', text: '管理员已有权限,无需设置' }));
          return;
        }
      }
      try {
        const managers = await storage.setRoomManager(roomId, target, on);
        broadcastToRoom(roomId, { type: 'room_managers_changed', room_id: roomId, managers, by: userInfo.name, on, name: target });
        // 通知被设置/取消的用户(若在线)
        const tSet = nameToSockets.get(target);
        if (tSet) {
          const payload = JSON.stringify({
            type: 'notice',
            text: (on ? '你已被设为房间"管理"' : '你的房间"管理"头衔已被取消') + '（' + room.name + '）'
          });
          for (const s of tSet) { if (s.readyState === WebSocket.OPEN) s.send(payload); }
        }
      } catch (e) {
        socket.send(JSON.stringify({ type: 'notice', text: '设置失败:' + e.message }));
      }
      return;
    }

    // ---- 群聊消息 ----
    if (msg.type === 'chat') {
      // 前端指定发送到哪个房间
      const curRoomId = String(msg.room_id || '').slice(0, 32).trim() || userInfo.activeRoomId || DEFAULT_ROOM_ID;
      // 校验:必须已加入该房间才能发言
      if (userInfo.roomIds && !userInfo.roomIds.has(curRoomId)) {
        socket.send(JSON.stringify({ type: 'notice', text: '未加入该房间,无法发言' }));
        return;
      }
      // 全员禁言时只有管理员能发
      if (globalMuted && !userInfo.isAdmin) {
        socket.send(JSON.stringify({ type: 'notice', text: '聊天室已被全员禁言' }));
        return;
      }
      // 房间级禁言
      if (roomMuted.get(curRoomId) && !userInfo.isAdmin) {
        socket.send(JSON.stringify({ type: 'notice', text: '当前房间已被禁言' }));
        return;
      }
      const now = Date.now();
      if (now - userInfo.lastSend < RATE_LIMIT_MS) {
        sendRateLimitedNotice(socket, '发送过快,每条消息间隔至少 ' + RATE_LIMIT_MS + 'ms');
        return;
      }
      // 滑动窗口限流:2 秒内最多 8 条
      if (!slidingWindowRateLimit(userInfo.msgTimes, now, MSG_WINDOW_LIMIT, MSG_WINDOW_MS)) {
        sendRateLimitedNotice(socket, '发送过于频繁,' + (MSG_WINDOW_MS/1000) + ' 秒内最多 ' + MSG_WINDOW_LIMIT + ' 条消息');
        return;
      }
      // 每分钟限流:最多 60 条
      if (!slidingWindowRateLimit(userInfo.msgTimesMin, now, MSG_PER_MINUTE_LIMIT, 60000)) {
        sendRateLimitedNotice(socket, '发送过于频繁,每分钟最多 ' + MSG_PER_MINUTE_LIMIT + ' 条消息');
        return;
      }
      userInfo.lastSend = now;

      const contentType = msg.content_type || 'text';
      const content = String(msg.content || '').slice(0, MAX_MSG_LENGTH);
      const file = msg.file || null;
      // 文本消息内容不能空
      if (contentType === 'text' && !content.trim()) return;

      let quote = null;
      if (msg.quote_id) quote = await findQuoteSnapshot('group', userInfo.name, null, msg.quote_id, curRoomId);

      const row = await storage.addMessage({
        scope: 'group', room_id: curRoomId, sender: userInfo.name, receiver: null,
        content, content_type: contentType, file,
        quote_id: msg.quote_id || null, quote, time: now
      });

      broadcastToRoom(curRoomId, {
        type: 'chat',
        id: row.id,
        name: userInfo.name,
        content: row.content,
        content_type: row.content_type,
        file: row.file,
        quote,
        revoked: 0,
        time: now,
        room_id: curRoomId
      });
      return;
    }

    // ---- 私聊消息 ----
    if (msg.type === 'private_chat') {
      const now = Date.now();
      if (now - userInfo.lastSend < RATE_LIMIT_MS) {
        sendRateLimitedNotice(socket, '发送过快,每条消息间隔至少 ' + RATE_LIMIT_MS + 'ms');
        return;
      }
      if (!slidingWindowRateLimit(userInfo.msgTimes, now, MSG_WINDOW_LIMIT, MSG_WINDOW_MS)) {
        sendRateLimitedNotice(socket, '发送过于频繁,' + (MSG_WINDOW_MS/1000) + ' 秒内最多 ' + MSG_WINDOW_LIMIT + ' 条消息');
        return;
      }
      if (!slidingWindowRateLimit(userInfo.msgTimesMin, now, MSG_PER_MINUTE_LIMIT, 60000)) {
        sendRateLimitedNotice(socket, '发送过于频繁,每分钟最多 ' + MSG_PER_MINUTE_LIMIT + ' 条消息');
        return;
      }
      userInfo.lastSend = now;

      const to = String(msg.to || '').slice(0, MAX_NAME_LENGTH).trim();
      const contentType = msg.content_type || 'text';
      const content = String(msg.content || '').slice(0, MAX_MSG_LENGTH);
      const file = msg.file || null;
      if (!to) return;
      if (contentType === 'text' && !content.trim()) return;

      let quote = null;
      if (msg.quote_id) quote = await findQuoteSnapshot('private', userInfo.name, to, msg.quote_id);

      const row = await storage.addMessage({
        scope: 'private', sender: userInfo.name, receiver: to,
        content, content_type: contentType, file,
        quote_id: msg.quote_id || null, quote, time: now
      });

      const payload = {
        type: 'private_chat',
        id: row.id,
        from: userInfo.name,
        to: to,
        content: row.content,
        content_type: row.content_type,
        file: row.file,
        quote,
        revoked: 0,
        time: now
      };
      const delivered = sendToName(to, payload);
      socket.send(JSON.stringify(payload));
      if (!delivered) {
        socket.send(JSON.stringify({
          type: 'private_notice', to, text: '对方当前不在线，消息已保存'
        }));
      }
      return;
    }

    // ---- 请求私聊历史 ----
    if (msg.type === 'private_history') {
      const peer = String(msg.peer || '').slice(0, MAX_NAME_LENGTH).trim();
      if (!peer) return;
      const hist = await storage.getPrivateHistory(userInfo.name, peer);
      // 前端私聊消息使用 from/to 字段，存储层返回的是 sender/receiver
      const formatted = hist.map(m => ({
        id: m.id, from: m.sender, to: m.receiver,
        content: m.content, content_type: m.content_type, file: m.file,
        quote: m.quote, revoked: m.revoked, revoked_by: m.revoked_by, time: m.time
      }));
      socket.send(JSON.stringify({ type: 'private_history', peer, data: formatted }));
      // 标记该会话已读(清未读数)
      storage.markPrivateRead(userInfo.name, peer).catch(() => {});
      return;
    }

    // ---- 撤回消息 ----
    if (msg.type === 'revoke') {
      const id = msg.id;
      if (!id) return;
      const m = await storage.getMessageById(id);
      if (!m) return;
      // 权限：本人且在窗口内，或房主（仅对该消息所在房间），或全局管理员
      const isOwner = m.sender === userInfo.name;
      const inWindow = (Date.now() - m.time) <= REVOKE_WINDOW_MS;
      let canRevoke = userInfo.isAdmin || (isOwner && inWindow);
      if (!canRevoke && m.scope === 'group' && m.room_id) {
        const targetRoom = await storage.getRoom(m.room_id);
        if (targetRoom && targetRoom.owner === userInfo.name) canRevoke = true;
      }
      if (!canRevoke) {
        socket.send(JSON.stringify({ type: 'notice', text: '无权撤回此消息（已超时或非本人/房主）' }));
        return;
      }
      await storage.revokeMessage(id, userInfo.name);
      // 广播撤回：群聊仅广播给该房间成员，私聊发给双方
      if (m.scope === 'group') {
        broadcastToRoom(m.room_id || DEFAULT_ROOM_ID, { type: 'revoke', id, by: userInfo.name, scope: 'group', room_id: m.room_id || DEFAULT_ROOM_ID });
      } else {
        const payload = { type: 'revoke', id, by: userInfo.name, scope: 'private', peer: m.sender === userInfo.name ? m.receiver : m.sender };
        socket.send(JSON.stringify(payload));
        sendToName(m.receiver === userInfo.name ? m.sender : m.receiver, payload);
      }
      return;
    }

    // ---- 管理员：强制下线 ----
    if (msg.type === 'admin_kick') {
      if (!userInfo.isAdmin) return;
      const target = String(msg.name || '').slice(0, MAX_NAME_LENGTH).trim();
      if (!target) return;
      // 时长单位:分钟,可填小数;0=永久禁止进入;上限 7 天(10080 分钟)
      const minutes = parseFloat(msg.duration_minutes);
      let banMinutes = isNaN(minutes) || minutes < 0 ? 0 : minutes;
      if (banMinutes > 10080) banMinutes = 10080;
      // 通过在线连接判断目标身份
      const targetSet = nameToSockets.get(target);
      const targetInfo = targetSet && targetSet.size > 0 ? clients.get(Array.from(targetSet)[0]) : null;
      const targetIsAdmin = targetInfo && targetInfo.isAdmin;
      const targetIsSuper = targetInfo && targetInfo.isSuperAdmin;
      // 子管理员不能踢主管理员和其他子管理员
      if (!userInfo.isSuperAdmin) {
        if (isAdminName(target) || targetIsSuper) {
          socket.send(JSON.stringify({ type: 'notice', text: '无权操作:不能踢主管理员' }));
          return;
        }
        if (targetIsAdmin) {
          socket.send(JSON.stringify({ type: 'notice', text: '无权操作:子管理员不能踢其他管理员' }));
          return;
        }
      } else {
        // 主管理员也不能踢自己
        if (target === userInfo.name) {
          socket.send(JSON.stringify({ type: 'notice', text: '不能踢自己' }));
          return;
        }
      }
      // 记录禁令:到期前目标无法重新进入
      if (banMinutes > 0) kickedUsers.set(target, Date.now() + Math.round(banMinutes * 60000));
      else kickedUsers.set(target, Infinity); // 永久
      const set = nameToSockets.get(target);
      if (set) {
        const payload = JSON.stringify({
          type: 'kicked', by: userInfo.name, duration_minutes: banMinutes,
          until: banMinutes > 0 ? Date.now() + Math.round(banMinutes * 60000) : 0
        });
        for (const s of set) {
          if (s.readyState === WebSocket.OPEN) {
            s.send(payload);
            s.close();
          }
        }
      }
      broadcast({ type: 'notice', text: '管理员将 ' + target + ' 强制下线(' + formatKickDuration(banMinutes) + ')' });
      return;
    }

    // ---- 管理员：全员禁言 ----
    if (msg.type === 'admin_mute') {
      if (!userInfo.isAdmin) return;
      globalMuted = !!msg.muted;
      broadcast({ type: 'mute_changed', muted: globalMuted, by: userInfo.name });
      return;
    }

    // ---- 管理员：查所有私聊对 ----
    if (msg.type === 'admin_list_private_pairs') {
      if (!userInfo.isAdmin) return;
      const pairs = await storage.listPrivatePairs();
      socket.send(JSON.stringify({ type: 'admin_private_pairs', data: pairs }));
      return;
    }

    // ---- 管理员：查指定对的私聊历史 ----
    if (msg.type === 'admin_private_history') {
      if (!userInfo.isAdmin) return;
      const a = String(msg.a || '').slice(0, MAX_NAME_LENGTH).trim();
      const b = String(msg.b || '').slice(0, MAX_NAME_LENGTH).trim();
      if (!a || !b) return;
      const hist = await storage.getPrivateHistory(a, b);
      socket.send(JSON.stringify({ type: 'admin_private_history', a, b, data: hist }));
      return;
    }

    // ---- 管理员：获取统计信息 ----
    if (msg.type === 'admin_get_stats') {
      if (!userInfo.isAdmin) return;
      const stats = await storage.getStats();
      socket.send(JSON.stringify({ type: 'admin_stats', data: stats }));
      return;
    }

    // ---- 管理员：清理旧消息（按天数）----
    if (msg.type === 'admin_clean_old_messages') {
      if (!userInfo.isAdmin) return;
      const days = parseInt(msg.days, 10) || 30;
      const result = await storage.cleanOldMessages(days);
      const stats = await storage.getStats();
      socket.send(JSON.stringify({
        type: 'admin_clean_result', action: 'old_messages', result, stats
      }));
      // 通知所有在线用户:历史已失效,需重新拉取(旧消息可能从已加载列表中消失)
      notifyHistoryInvalidated([], []);
      // 通知其他在线管理员刷新统计
      const summary = { source: 'manual', time: Date.now(), old_messages: result, by: userInfo.name };
      for (const client of wss.clients) {
        if (client === socket || client.readyState !== WebSocket.OPEN) continue;
        const info = clients.get(client);
        if (info && info.isAdmin) client.send(JSON.stringify({ type: 'admin_auto_clean_done', summary }));
      }
      return;
    }

    // ---- 管理员：清理已撤回消息 + 孤儿文件 ----
    if (msg.type === 'admin_clean_revoked') {
      if (!userInfo.isAdmin) return;
      const result = await storage.cleanRevokedAndOrphans();
      const stats = await storage.getStats();
      socket.send(JSON.stringify({
        type: 'admin_clean_result', action: 'revoked_orphans', result, stats
      }));
      // 通知所有在线用户:历史已失效,需重新拉取(撤回消息记录已被删除)
      notifyHistoryInvalidated([], []);
      // 通知其他在线管理员刷新统计
      const summary = { source: 'manual', time: Date.now(), revoked: result, by: userInfo.name };
      for (const client of wss.clients) {
        if (client === socket || client.readyState !== WebSocket.OPEN) continue;
        const info = clients.get(client);
        if (info && info.isAdmin) client.send(JSON.stringify({ type: 'admin_auto_clean_done', summary }));
      }
      return;
    }

    // ---- 管理员：查询定时清理配置 ----
    if (msg.type === 'admin_get_clean_config') {
      if (!userInfo.isAdmin) return;
      socket.send(JSON.stringify({
        type: 'admin_clean_config',
        config: {
          enabled: AUTO_CLEAN_ENABLED,
          hour: AUTO_CLEAN_HOUR,
          old_days: AUTO_CLEAN_OLD_DAYS,
          next_run: autoCleanNextRun,
          next_run_str: autoCleanNextRun ? new Date(autoCleanNextRun).toLocaleString('zh-CN') : null
        }
      }));
      return;
    }

    // ---- 管理员：手动触发一次自动清理(等同定时任务立即执行) ----
    if (msg.type === 'admin_trigger_auto_clean') {
      if (!userInfo.isAdmin) return;
      socket.send(JSON.stringify({ type: 'notice', text: '已触发定时清理任务,结果将通过系统消息推送' }));
      const summary = await runAutoClean('manual');
      // 给触发者也发一份结果
      socket.send(JSON.stringify({ type: 'admin_auto_clean_done', summary }));
      return;
    }

    // ---- 管理员：清理孤儿房间（无房主的非 default 房间）----
    if (msg.type === 'admin_clean_orphan_rooms') {
      if (!userInfo.isAdmin) return;
      // 清理前先找出孤儿房间 id（owner 为空的非 default 房间）
      // cleanOrphanRooms 返回的 rooms 是 "name (id)" 格式,不便解析 id,所以这里预先提取
      const allRooms = await storage.listRooms();
      const orphanRoomIds = allRooms
        .filter(r => r.id !== DEFAULT_ROOM_ID && (!r.owner || r.owner.trim() === ''))
        .map(r => r.id);
      const result = await storage.cleanOrphanRooms();
      // 把孤儿房间的在线用户移回 default
      for (const rid of orphanRoomIds) {
        const set = roomToSockets.get(rid);
        if (set && set.size > 0) {
          const socketsToMove = Array.from(set);
          for (const s of socketsToMove) {
            removeSocketFromRoom(rid, s);
            const info = clients.get(s);
            if (info) {
              info.roomId = DEFAULT_ROOM_ID;
              addSocketToRoom(DEFAULT_ROOM_ID, s);
            }
            if (s.readyState === WebSocket.OPEN) {
              // 通知该用户房间被删
              s.send(JSON.stringify({ type: 'room_deleted', room_id: rid, by: userInfo.name }));
              // 发送 default 房间信息与历史
              const defaultRoom = await storage.getRoom(DEFAULT_ROOM_ID);
              const dh = await storage.getGroupHistory(DEFAULT_ROOM_ID);
              const dfmt = dh.map(m => ({
                id: m.id, name: m.sender, content: m.content,
                content_type: m.content_type, file: m.file, quote: m.quote,
                revoked: m.revoked, revoked_by: m.revoked_by, time: m.time, room_id: m.room_id
              }));
              s.send(JSON.stringify({
                type: 'room_joined', room: defaultRoom, history: dfmt,
                room_muted: !!roomMuted.get(DEFAULT_ROOM_ID)
              }));
            }
          }
        }
      }
      if (orphanRoomIds.length > 0) broadcastRoomUserList(DEFAULT_ROOM_ID);
      const stats = await storage.getStats();
      socket.send(JSON.stringify({
        type: 'admin_clean_result', action: 'orphan_rooms', result, stats
      }));
      return;
    }

    // ---- 管理员：查看所有房间(含在线人数,用于管理后台) ----
    if (msg.type === 'admin_list_rooms') {
      if (!userInfo.isAdmin) {
        socket.send(JSON.stringify({ type: 'notice', text: '无权操作:仅管理员可查看房间列表' }));
        return;
      }
      const rooms = await storage.listRooms();
      rooms.forEach(r => { r.online = roomOnlineCount(r.id); });
      socket.send(JSON.stringify({ type: 'admin_room_list', data: rooms }));
      return;
    }

    // ---- 管理员：查看上传记录(可追溯) ----
    if (msg.type === 'admin_list_uploads') {
      if (!userInfo.isAdmin) {
        socket.send(JSON.stringify({ type: 'notice', text: '无权操作:仅管理员可查看上传记录' }));
        return;
      }
      const kw = String(msg.kw || '').slice(0, 64).trim();
      const limit = parseInt(msg.limit || '200', 10);
      try {
        const uploads = await storage.listUploads({ limit, kw });
        socket.send(JSON.stringify({ type: 'admin_upload_list', data: uploads }));
      } catch (e) {
        socket.send(JSON.stringify({ type: 'notice', text: '查询上传记录失败:' + e.message }));
      }
      return;
    }

    // ---- 管理员：查看所有用户(注册用户 + 当前在线临时用户) ----
    if (msg.type === 'admin_list_users') {
      if (!userInfo.isAdmin) {
        socket.send(JSON.stringify({ type: 'notice', text: '无权操作:仅管理员可查看用户列表' }));
        return;
      }
      const registered = await storage.listUsers();
      // 附加在线状态(按 nickname 匹配)
      const onlineNames = new Set(onlineUsers());
      const result = registered.map(u => ({
        id: u.id,
        username: u.username,
        nickname: u.nickname,
        is_admin: u.is_admin,
        is_super_admin: u.username === ADMIN_NAME,
        is_registered: true,
        online: onlineNames.has(u.nickname),
        created_at: u.created_at,
        last_login: u.last_login
      }));
      // 添加当前在线的临时用户(不在 users 表中的)
      const registeredNicks = new Set(registered.map(u => u.nickname));
      for (const info of clients.values()) {
        if (info && info.name && !registeredNicks.has(info.name) && !result.find(u => u.nickname === info.name)) {
          result.push({
            id: null,
            username: null,
            nickname: info.name,
            is_admin: info.isAdmin ? 1 : 0,
            is_super_admin: info.isSuperAdmin,
            is_registered: info.isRegistered,
            online: true,
            created_at: null,
            last_login: null
          });
        }
      }
      socket.send(JSON.stringify({ type: 'admin_user_list', data: result }));
      return;
    }

    // ---- 管理员：删除任意房间(管理员权限,可删他人房间) ----
    if (msg.type === 'admin_delete_room') {
      if (!userInfo.isAdmin) {
        socket.send(JSON.stringify({ type: 'notice', text: '无权操作:仅管理员可删除房间' }));
        return;
      }
      const roomId = String(msg.room_id || '').slice(0, 32).trim();
      if (!roomId) { socket.send(JSON.stringify({ type: 'notice', text: '房间 ID 不能为空' })); return; }
      if (roomId === DEFAULT_ROOM_ID) {
        socket.send(JSON.stringify({ type: 'notice', text: '不能删除默认房间' }));
        return;
      }
      const room = await storage.getRoom(roomId);
      if (!room) {
        socket.send(JSON.stringify({ type: 'notice', text: '房间不存在' }));
        return;
      }
      // 子管理员不能删除其他管理员创建的房间
      if (!userInfo.isSuperAdmin && room.owner !== userInfo.name) {
        const ownerUser = await storage.getUserByNickname(room.owner);
        if (ownerUser && ownerUser.is_admin === 1) {
          socket.send(JSON.stringify({ type: 'notice', text: '无权操作:不能删除其他管理员创建的房间' }));
          return;
        }
      }
      try {
        await storage.deleteRoom(roomId);
        // 将房间内所有成员踢回 default
        const set = roomToSockets.get(roomId);
        if (set) {
          const members = Array.from(set);
          for (const s of members) {
            removeSocketFromRoom(roomId, s);
            const sInfo = clients.get(s);
            if (sInfo) {
              sInfo.roomIds.delete(roomId);
              if (sInfo.activeRoomId === roomId) {
                sInfo.activeRoomId = DEFAULT_ROOM_ID;
                addSocketToRoom(DEFAULT_ROOM_ID, s);
                sInfo.roomIds.add(DEFAULT_ROOM_ID);
                const defRoom = await storage.getRoom(DEFAULT_ROOM_ID);
                s.send(JSON.stringify({
                  type: 'room_joined', room: defRoom, history: [],
                  room_muted: !!roomMuted.get(DEFAULT_ROOM_ID), forced: true
                }));
                s.send(JSON.stringify({ type: 'notice', text: '房间 "' + room.name + '" 已被管理员删除' }));
              }
            }
          }
        }
        socket.send(JSON.stringify({ type: 'room_deleted', room_id: roomId, by_admin: true }));
      } catch (e) {
        socket.send(JSON.stringify({ type: 'notice', text: '删除失败:' + e.message }));
      }
      return;
    }

    if (msg.type === 'admin_list_admins') {
      if (!userInfo.isSuperAdmin) {
        socket.send(JSON.stringify({ type: 'notice', text: '无权操作:仅主管理员可查看管理员列表' }));
        return;
      }
      const subAdmins = await storage.listAdmins();
      const allAdmins = [
        { name: ADMIN_NAME, username: ADMIN_NAME, created_at: 0, is_super: true },
        ...subAdmins.map(a => ({
          name: a.name, username: a.username,
          created_at: a.created_at, is_super: false
        }))
      ];
      socket.send(JSON.stringify({ type: 'admin_list', data: allAdmins }));
      return;
    }

    // ---- 主管理员：升级用户为子管理员(通过 username) ----
    if (msg.type === 'admin_add_admin') {
      if (!userInfo.isSuperAdmin) {
        socket.send(JSON.stringify({ type: 'notice', text: '无权操作:仅主管理员可添加管理员' }));
        return;
      }
      const username = String(msg.username || '').slice(0, 64).trim();
      if (!username) { socket.send(JSON.stringify({ type: 'notice', text: '用户名不能为空' })); return; }
      if (username === ADMIN_NAME) {
        socket.send(JSON.stringify({ type: 'notice', text: '不能操作主管理员' }));
        return;
      }
      try {
        await storage.addAdmin(username);
        // 踢下线该用户,让其重新登录后生效权限
        const targetUser = await storage.getUserByUsername(username);
        if (targetUser) {
          const set = nameToSockets.get(targetUser.nickname);
          if (set) {
            const payload = JSON.stringify({
              type: 'kicked', by: userInfo.name, duration: 0, until: 0,
              reason: '你已被升级为管理员,请重新登录'
            });
            for (const s of Array.from(set)) {
              if (s.readyState === WebSocket.OPEN) { s.send(payload); s.close(); }
            }
          }
        }
        const adminInfo = await storage.getUserByUsername(username);
        socket.send(JSON.stringify({
          type: 'admin_added',
          admin: adminInfo ? { name: adminInfo.nickname, username: adminInfo.username, created_at: adminInfo.created_at } : null
        }));
      } catch (e) {
        socket.send(JSON.stringify({ type: 'notice', text: '添加失败:' + e.message }));
      }
      return;
    }

    // ---- 主管理员：撤销子管理员权限(通过 username) ----
    if (msg.type === 'admin_remove_admin') {
      if (!userInfo.isSuperAdmin) {
        socket.send(JSON.stringify({ type: 'notice', text: '无权操作:仅主管理员可删除管理员' }));
        return;
      }
      const username = String(msg.username || '').slice(0, 64).trim();
      if (!username) { socket.send(JSON.stringify({ type: 'notice', text: '请指定要删除的管理员' })); return; }
      if (username === ADMIN_NAME) {
        socket.send(JSON.stringify({ type: 'notice', text: '不能删除主管理员' }));
        return;
      }
      // 先找到该用户,踢下线
      const targetUser = await storage.getUserByUsername(username);
      if (targetUser) {
        const set = nameToSockets.get(targetUser.nickname);
        if (set) {
          const payload = JSON.stringify({
            type: 'kicked', by: userInfo.name, duration: 0, until: 0,
            reason: '管理员权限已被移除'
          });
          for (const s of Array.from(set)) {
            if (s.readyState === WebSocket.OPEN) { s.send(payload); s.close(); }
          }
        }
        const ok = await storage.removeAdmin(username);
        if (ok) {
          socket.send(JSON.stringify({ type: 'admin_removed', name: targetUser.nickname, username }));
        } else {
          socket.send(JSON.stringify({ type: 'notice', text: '删除失败:该用户不是子管理员' }));
        }
      } else {
        socket.send(JSON.stringify({ type: 'notice', text: '删除失败:用户不存在' }));
      }
      return;
    }

    // ---- 管理员：完全重置数据库（危险操作,需二次确认,仅主管理员）----
    if (msg.type === 'admin_reset_db') {
      if (!userInfo.isSuperAdmin) {
        socket.send(JSON.stringify({ type: 'notice', text: '无权操作:仅主管理员可重置数据库' }));
        return;
      }
      // 二次确认：前端必须显式发送 { confirm: true }
      if (msg.confirm !== true) {
        socket.send(JSON.stringify({
          type: 'admin_clean_result', action: 'reset', error: '需要二次确认'
        }));
        return;
      }
      const result = await storage.resetDatabase();
      // 把所有在线用户移回 default 房间
      const defaultRoom = await storage.getRoom(DEFAULT_ROOM_ID);
      const dh = await storage.getGroupHistory(DEFAULT_ROOM_ID);
      const dfmt = dh.map(m => ({
        id: m.id, name: m.sender, content: m.content,
        content_type: m.content_type, file: m.file, quote: m.quote,
        revoked: m.revoked, revoked_by: m.revoked_by, time: m.time, room_id: m.room_id
      }));
      for (const client of wss.clients) {
        const info = clients.get(client);
        if (!info) continue;
        const oldRoomId = info.roomId;
        if (oldRoomId && oldRoomId !== DEFAULT_ROOM_ID) {
          removeSocketFromRoom(oldRoomId, client);
        }
        // 重置所有用户的 roomId 到 default
        info.roomId = DEFAULT_ROOM_ID;
        addSocketToRoom(DEFAULT_ROOM_ID, client);
        if (client.readyState === WebSocket.OPEN) {
          // 强制切回 default（前端收到 room_joined 会切回 default 视图）
          client.send(JSON.stringify({
            type: 'room_joined', room: defaultRoom, history: dfmt,
            room_muted: !!roomMuted.get(DEFAULT_ROOM_ID)
          }));
        }
      }
      // 通知所有人数据库已被重置
      broadcast({ type: 'notice', text: '管理员已重置数据库,所有房间已清空', by: userInfo.name });
      broadcastRoomUserList(DEFAULT_ROOM_ID);
      const stats = await storage.getStats();
      socket.send(JSON.stringify({
        type: 'admin_clean_result', action: 'reset', result, stats
      }));
      return;
    }

    // ---- 修改密码(注册用户/主管理员) ----
    if (msg.type === 'change_password') {
      const oldPwd = String(msg.old_password || '');
      const newPwd = String(msg.new_password || '');
      if (newPwd.length < 6 || newPwd.length > 50) {
        socket.send(JSON.stringify({ type: 'change_pwd_result', ok: false, error: '新密码需为 6-50 位' }));
        return;
      }
      let targetUserId = null;
      if (userInfo.isSuperAdmin) {
        // 主管理员:目标为 users 表中的主管理员账户(快速进入时无 userId)
        const adminUser = await storage.getUserByUsername(ADMIN_NAME);
        if (!adminUser) {
          socket.send(JSON.stringify({ type: 'change_pwd_result', ok: false, error: '主管理员账户异常,无法修改' }));
          return;
        }
        targetUserId = adminUser.id;
      } else if (userInfo.isRegistered && userInfo.userId) {
        targetUserId = userInfo.userId;
      } else {
        socket.send(JSON.stringify({ type: 'change_pwd_result', ok: false, error: '未登录,无法修改密码' }));
        return;
      }
      const result = await storage.changePassword({ userId: targetUserId, oldPassword: oldPwd, newPassword: newPwd });
      if (!result.ok) {
        socket.send(JSON.stringify({ type: 'change_pwd_result', ok: false, error: result.error }));
        return;
      }
      // 主管理员:同步 .env 的 ADMIN_PASSWORD,保证"快速进入"与"账号登录"一致
      if (userInfo.isSuperAdmin) {
        updateEnvAdminPassword(newPwd);
      }
      // 改密后使该用户所有 session 失效,强制重新登录
      await storage.deleteUserSessions(targetUserId);
      socket.send(JSON.stringify({ type: 'change_pwd_result', ok: true }));
      return;
    }

    // ---- 登出(仅注册用户) ----
    if (msg.type === 'logout') {
      if (userInfo && userInfo.token) {
        await storage.deleteSession(userInfo.token);
      }
      socket.send(JSON.stringify({ type: 'logged_out' }));
      socket.close();
      return;
    }
  });

  socket.on('close', () => {
    const info = clients.get(socket);
    console.log(`[conn] 连接断开 name=${info && info.name ? info.name : '未进入会话'} IP=${socket._clientIp}`);
    if (info && info.name) removeSocketFromName(info.name, socket);
    // 从所有已加入的房间移除
    const roomIds = info && info.roomIds;
    if (roomIds) {
      for (const rid of Array.from(roomIds)) {
        removeSocketFromRoom(rid, socket);
        syncRoomIdleState(rid); // 断线可能使房间变空,同步空闲标记
        // 同名无其它活跃连接时,向该房间广播下线
        if (info && info.name && !nameToSockets.has(info.name)) {
          const count = onlineCount();
          broadcastToRoom(rid, { type: 'offline', name: info.name, count, time: Date.now(), room_id: rid });
          broadcastRoomUserList(rid);
        }
      }
    }
    // 从 IP 表中移除
    if (socket._clientIp) removeSocketFromIp(socket._clientIp, socket);
    clients.delete(socket);
  });

  socket.on('error', () => {
    const info = clients.get(socket);
    if (info && info.name) removeSocketFromName(info.name, socket);
    if (info && info.roomIds) {
      for (const rid of Array.from(info.roomIds)) {
        removeSocketFromRoom(rid, socket);
        syncRoomIdleState(rid);
      }
    }
    if (socket._clientIp) removeSocketFromIp(socket._clientIp, socket);
    clients.delete(socket);
  });
});

// ============ 启动 ============
(async () => {
  await storage.init();
  r2.initR2(); // 初始化 R2(未配置环境变量时自动 fallback 到本地存储)
  const rooms = await storage.listRooms();
  const subAdmins = await storage.listAdmins();
  server.listen(PORT, HOST, () => {
    console.log('========================================');
    console.log('  轻量化聊天服务已启动');
    console.log('========================================');
    console.log(`  存储模式: ${storage.getMode() === 'mysql' ? 'MySQL' : '文件(messages.json)'}`);
    console.log(`  文件存储: ${r2.isR2Enabled() ? 'Cloudflare R2' : '本地 uploads/ 目录'}`);
    console.log(`  本机访问:  http://localhost:${PORT}`);
    console.log(`  局域网/公网: http://<你的IP>:${PORT}`);
    console.log(`  主管理员: ${ADMIN_NAME}（${ADMIN_PASSWORD ? '已配置密码' : '未配置密码，管理员功能关闭'}）`);
    console.log(`  子管理员: ${subAdmins.length} 个${subAdmins.length > 0 ? '（' + subAdmins.map(a => a.name).join(', ') + '）' : ''}`);
    console.log(`  全员禁言初始: ${globalMuted ? '是' : '否'}`);
    console.log(`  房间数量: ${rooms.length}（含默认房间）`);
    if (!r2.isR2Enabled()) console.log(`  上传目录: ${UPLOAD_DIR}`);
    console.log(`  心跳检测: 已启用（每 ${HEARTBEAT_INTERVAL / 1000} 秒一次）`);
    console.log(`  IP 限制: ${DISABLE_IP_LIMIT ? '已禁用(测试模式)' : '已启用(单 IP 最大 ' + MAX_CONNECTIONS_PER_IP + ' 连接)'}`);
    console.log(`  消息限流: 间隔 ${RATE_LIMIT_MS}ms, 窗口 ${MSG_WINDOW_MS/1000}秒/${MSG_WINDOW_LIMIT}条, 每分钟 ${MSG_PER_MINUTE_LIMIT}条`);
    if (AUTO_CLEAN_ENABLED) {
      console.log(`  定时清理: 已启用(每天 ${AUTO_CLEAN_HOUR}:00 清理撤回+孤儿${AUTO_CLEAN_OLD_DAYS > 0 ? ',及 ' + AUTO_CLEAN_OLD_DAYS + ' 天前旧消息' : ''})`);
    } else {
      console.log(`  定时清理: 已禁用(可通过 AUTO_CLEAN_ENABLED=1 启用)`);
    }
    console.log(`  房间空闲清理: 已启用(每 ${ROOM_IDLE_CHECK_MS / 60000} 分钟扫描空闲超时公开房间)`);
    console.log('  按 Ctrl+C 停止服务');
    console.log('========================================');
  });

  // 心跳定时器：遍历所有连接，标记死亡连接并强制断开
  // terminate() 会触发 close 事件，自动清理 nameToSockets 中的昵称占用
  const heartbeatTimer = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL);

  // 定期清理过期 session(每小时一次)
  const sessionCleanTimer = setInterval(() => {
    storage.cleanExpiredSessions().catch(() => {});
  }, 60 * 60 * 1000);

  // 启动定时清理调度器(每天 AUTO_CLEAN_HOUR 点清理撤回消息+孤儿文件)
  startAutoCleanScheduler();

  // 启动公开房间空闲清理调度器(每 5 分钟扫描到期房间)
  startIdleRoomScheduler();

  // 服务关闭时清理定时器
  wss.on('close', () => {
    clearInterval(heartbeatTimer);
    clearInterval(sessionCleanTimer);
    clearInterval(idleRoomTimer);
    if (autoCleanTimer) {
      clearTimeout(autoCleanTimer);
      clearInterval(autoCleanTimer);
      autoCleanTimer = null;
    }
  });
})();
