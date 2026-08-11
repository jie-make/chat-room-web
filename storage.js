// 存储抽象层：支持 MySQL 与文件两种模式
// 通过环境变量 USE_MYSQL=true 启用 MySQL，否则使用文件存储
const fs = require('fs');
const path = require('path');

const MESSAGES_FILE = path.join(__dirname, 'messages.json');
const ROOMS_FILE = path.join(__dirname, 'rooms.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const UPLOADS_FILE = path.join(__dirname, 'uploads.json');
const MAX_HISTORY = 500;

// 消息统一结构：
// { id, scope, room_id, sender, receiver, content, content_type, file, quote_id, quote, revoked, time }
//   scope: 'group' | 'private'
//   room_id: 房间 ID（仅 group 消息使用，private 消息忽略）
//   content_type: 'text' | 'image' | 'file'
//   file: { name, url, size, mime }  （图片/文件消息时）
//   revoked: 0 | 1  是否被撤回

let mode = 'file';
let pool = null;

// ---------- 文件模式实现 ----------
let fileMessages = [];
let fileRooms = [];
let fileUsers = [];
let fileSessions = [];
function loadFile() {
  try {
    if (fs.existsSync(MESSAGES_FILE)) {
      const arr = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
      if (Array.isArray(arr)) { fileMessages = arr; return; }
    }
  } catch (e) {
    console.error('[storage] 读取消息文件失败:', e.message);
  }
  fileMessages = [];
}
function saveFile() {
  try {
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(fileMessages), 'utf8');
  } catch (e) {
    console.error('[storage] 保存消息文件失败:', e.message);
  }
}
function loadRoomsFile() {
  try {
    if (fs.existsSync(ROOMS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
      if (Array.isArray(arr)) { fileRooms = arr; return; }
    }
  } catch (e) {
    console.error('[storage] 读取房间文件失败:', e.message);
  }
  // 初始化默认房间
  fileRooms = [{
    id: 'default', name: '公共大厅', password_hash: null,
    owner: process.env.ADMIN_NAME || 'admin', is_private: 0, created_at: Date.now()
  }];
  saveRoomsFile();
}
function saveRoomsFile() {
  try {
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(fileRooms), 'utf8');
  } catch (e) {
    console.error('[storage] 保存房间文件失败:', e.message);
  }
}
function loadUsersFile() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      if (Array.isArray(arr)) { fileUsers = arr; return; }
    }
  } catch (e) {
    console.error('[storage] 读取用户文件失败:', e.message);
  }
  fileUsers = [];
}
function saveUsersFile() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(fileUsers), 'utf8');
  } catch (e) {
    console.error('[storage] 保存用户文件失败:', e.message);
  }
}
function loadSessionsFile() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      if (Array.isArray(arr)) { fileSessions = arr; return; }
    }
  } catch (e) {
    console.error('[storage] 读取会话文件失败:', e.message);
  }
  fileSessions = [];
}
function saveSessionsFile() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(fileSessions), 'utf8');
  } catch (e) {
    console.error('[storage] 保存会话文件失败:', e.message);
  }
}
// 上传记录(文件模式)
let fileUploads = [];
function loadUploadsFile() {
  try {
    if (fs.existsSync(UPLOADS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(UPLOADS_FILE, 'utf8'));
      if (Array.isArray(arr)) { fileUploads = arr; return; }
    }
  } catch (e) {
    console.error('[storage] 读取上传记录文件失败:', e.message);
  }
  fileUploads = [];
}
function saveUploadsFile() {
  try {
    fs.writeFileSync(UPLOADS_FILE, JSON.stringify(fileUploads), 'utf8');
  } catch (e) {
    console.error('[storage] 保存上传记录文件失败:', e.message);
  }
}
loadFile();
loadRoomsFile();
loadUsersFile();
loadSessionsFile();
loadUploadsFile();

// ---------- MySQL 模式实现 ----------
async function initMysql() {
  const mysql = require('mysql2/promise');
  const cfg = {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'chat_db',
    waitForConnections: true,
    connectionLimit: 10
  };
  const admin = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password
  });
  await admin.query(
    `CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await admin.end();

  pool = mysql.createPool(cfg);

  // ---------- rooms 表 ----------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id            VARCHAR(32) PRIMARY KEY,
      name          VARCHAR(64) NOT NULL,
      password_hash VARCHAR(255) NULL,
      owner         VARCHAR(64) NOT NULL,
      is_private    TINYINT NOT NULL DEFAULT 0,
      idle_timeout_hours DOUBLE NULL DEFAULT NULL,
      empty_since   BIGINT NULL,
      managers      TEXT NULL,
      created_at    BIGINT NOT NULL,
      INDEX idx_owner (owner),
      INDEX idx_idle_cleanup (is_private, idle_timeout_hours, empty_since)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 兼容旧 rooms 表(若字段不存在则添加)
  const roomAlterCols = [
    "ADD COLUMN idle_timeout_hours DOUBLE NULL DEFAULT NULL",
    "ADD COLUMN empty_since BIGINT NULL",
    "ADD COLUMN managers TEXT NULL"
  ];
  for (const sql of roomAlterCols) {
    try { await pool.query(`ALTER TABLE rooms ${sql}`); } catch (e) { /* 已存在 */ }
  }
  // 兼容旧字段类型(旧版为 INT 小时,现支持分钟小数需 DOUBLE)
  try {
    await pool.query(`ALTER TABLE rooms MODIFY idle_timeout_hours DOUBLE NULL DEFAULT NULL`);
  } catch (e) {}
  try {
    await pool.query(`ALTER TABLE rooms ADD INDEX idx_idle_cleanup (is_private, idle_timeout_hours, empty_since)`);
  } catch (e) { /* 已存在 */ }

  // 自动创建默认房间（迁移现有 group 消息用）
  const [defaultRoom] = await pool.query(`SELECT id FROM rooms WHERE id='default' LIMIT 1`);
  if (defaultRoom.length === 0) {
    await pool.query(
      `INSERT INTO rooms (id, name, password_hash, owner, is_private, created_at)
       VALUES ('default', '公共大厅', NULL, '', 0, ?)`,
      [Date.now()]
    );
    console.log('[storage] 已创建默认房间 "公共大厅" (id=default)');
  }

  // ---------- messages 表 ----------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id           BIGINT AUTO_INCREMENT PRIMARY KEY,
      scope        VARCHAR(16) NOT NULL,
      room_id      VARCHAR(32) NOT NULL DEFAULT 'default',
      sender       VARCHAR(64) NOT NULL,
      receiver     VARCHAR(64) NULL,
      content      TEXT NOT NULL,
      content_type VARCHAR(16) NOT NULL DEFAULT 'text',
      file_name    VARCHAR(255) NULL,
      file_url     VARCHAR(500) NULL,
      file_size    BIGINT NULL,
      file_mime    VARCHAR(128) NULL,
      quote_id     BIGINT NULL,
      q_sender     VARCHAR(64) NULL,
      q_content    VARCHAR(500) NULL,
      revoked      TINYINT NOT NULL DEFAULT 0,
      revoked_by   VARCHAR(64) NULL,
      time         BIGINT NOT NULL,
      INDEX idx_scope (scope),
      INDEX idx_room (scope, room_id),
      INDEX idx_private (scope, sender, receiver),
      INDEX idx_time (time)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // 兼容旧表（若字段不存在则添加）
  const alterCols = [
    "ADD COLUMN content_type VARCHAR(16) NOT NULL DEFAULT 'text'",
    "ADD COLUMN room_id VARCHAR(32) NOT NULL DEFAULT 'default'",
    "ADD COLUMN file_name VARCHAR(255) NULL",
    "ADD COLUMN file_url VARCHAR(500) NULL",
    "ADD COLUMN file_size BIGINT NULL",
    "ADD COLUMN file_mime VARCHAR(128) NULL",
    "ADD COLUMN revoked TINYINT NOT NULL DEFAULT 0",
    "ADD COLUMN revoked_by VARCHAR(64) NULL"
  ];
  for (const sql of alterCols) {
    try { await pool.query(`ALTER TABLE messages ${sql}`); } catch (e) { /* 已存在 */ }
  }
  // 添加 room_id 索引（若不存在）
  try {
    await pool.query(`ALTER TABLE messages ADD INDEX idx_room (scope, room_id)`);
  } catch (e) { /* 已存在 */ }

  // ---------- uploads 表(文件上传可追溯记录) ----------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uploads (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      file_name  VARCHAR(255) NULL,
      file_url   VARCHAR(500) NULL,
      uploader   VARCHAR(64) NULL,
      user_id    BIGINT NULL,
      ip         VARCHAR(64) NULL,
      size       BIGINT NOT NULL DEFAULT 0,
      mime       VARCHAR(128) NULL,
      is_image   TINYINT NOT NULL DEFAULT 0,
      room_id    VARCHAR(32) NULL,
      created_at BIGINT NOT NULL,
      INDEX idx_uploader (uploader),
      INDEX idx_ip (ip),
      INDEX idx_time (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ---------- users 表（注册用户,子管理员复用此表）----------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            BIGINT AUTO_INCREMENT PRIMARY KEY,
      username      VARCHAR(64) NOT NULL UNIQUE,
      nickname      VARCHAR(64) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      is_admin      TINYINT NOT NULL DEFAULT 0,
      joined_rooms  TEXT NULL,
      created_at    BIGINT NOT NULL,
      last_login    BIGINT NULL,
      INDEX idx_username (username),
      INDEX idx_nickname (nickname)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // 兼容旧 users 表(若字段不存在则添加)
  const userAlterCols = ["ADD COLUMN joined_rooms TEXT NULL"];
  for (const sql of userAlterCols) {
    try { await pool.query(`ALTER TABLE users ${sql}`); } catch (e) { /* 已存在 */ }
  }

  // ---------- sessions 表（登录态,支持 token 自动登录）----------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token       VARCHAR(64) PRIMARY KEY,
      user_id     BIGINT NOT NULL,
      created_at  BIGINT NOT NULL,
      expires_at  BIGINT NOT NULL,
      INDEX idx_user (user_id),
      INDEX idx_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ---------- 旧 admins 表迁移到 users 表 ----------
  try {
    const [oldAdmins] = await pool.query(`SELECT name, password_hash, created_at FROM admins`);
    if (oldAdmins.length > 0) {
      for (const a of oldAdmins) {
        try {
          await pool.query(
            `INSERT INTO users (username, nickname, password_hash, is_admin, created_at, last_login)
             VALUES (?,?,?,?,?,NULL)`,
            [a.name, a.name, a.password_hash, 1, a.created_at]
          );
        } catch (e) { /* 已存在则跳过 */ }
      }
      await pool.query(`DROP TABLE admins`);
      console.log(`[storage] 已迁移 ${oldAdmins.length} 个子管理员到 users 表`);
    } else {
      await pool.query(`DROP TABLE admins`);
    }
  } catch (e) { /* admins 表不存在则跳过 */ }

  // ---------- private_read_status 表(私聊会话已读状态) ----------
  // 记录每个用户对每个私聊会话的最后已读时间,用于计算未读数
  await pool.query(`
    CREATE TABLE IF NOT EXISTS private_read_status (
      user_name    VARCHAR(64) NOT NULL,
      peer_name    VARCHAR(64) NOT NULL,
      last_read_at BIGINT NOT NULL,
      PRIMARY KEY (user_name, peer_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ---------- room_read_status 表(群聊/房间已读状态) ----------
  // 记录每个用户对每个房间的最后已读时间,用于计算房间未读数
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_read_status (
      user_name    VARCHAR(64) NOT NULL,
      room_id      VARCHAR(32) NOT NULL,
      last_read_at BIGINT NOT NULL,
      PRIMARY KEY (user_name, room_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  console.log(`[storage] MySQL 已连接：${cfg.host}:${cfg.port}/${cfg.database}`);
}

// ---------- 统一接口 ----------
async function addMessage(msg) {
  const content = String(msg.content || '').slice(0, 4000);
  const sender = String(msg.sender || '').slice(0, 64);
  const receiver = msg.receiver ? String(msg.receiver).slice(0, 64) : null;
  const quote = msg.quote || null;
  const contentType = msg.content_type || 'text';
  const file = msg.file || null;
  const time = msg.time || Date.now();
  const roomId = String(msg.room_id || 'default').slice(0, 32);

  if (mode === 'mysql') {
    const [res] = await pool.query(
      `INSERT INTO messages (scope, room_id, sender, receiver, content, content_type,
          file_name, file_url, file_size, file_mime, quote_id, q_sender, q_content, time)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [msg.scope, roomId, sender, receiver, content, contentType,
       file ? String(file.name || '').slice(0, 255) : null,
       file ? String(file.url || '').slice(0, 500) : null,
       file ? parseInt(file.size, 10) || null : null,
       file ? String(file.mime || '').slice(0, 128) : null,
       quote ? quote.id || null : null,
       quote ? String(quote.sender || '').slice(0, 64) : null,
       quote ? String(quote.content || '').slice(0, 500) : null,
       time]
    );
    return normalizeRow({
      id: res.insertId, scope: msg.scope, room_id: roomId, sender, receiver,
      content, content_type: contentType, file_name: file ? file.name : null,
      file_url: file ? file.url : null, file_size: file ? file.size : null,
      file_mime: file ? file.mime : null,
      quote_id: quote ? quote.id || null : null,
      q_sender: quote ? quote.sender : null,
      q_content: quote ? quote.content : null,
      revoked: 0, time
    });
  } else {
    const id = (fileMessages.length === 0 ? 0 : fileMessages[fileMessages.length - 1].id) + 1;
    const row = {
      id, scope: msg.scope, room_id: roomId, sender, receiver, content,
      content_type: contentType, file, quote_id: quote ? quote.id || null : null,
      quote, revoked: 0, revoked_by: null, time
    };
    fileMessages.push(row);
    // 按房间类型区分保留策略：公开房间 500 条，私密房间全部保留
    if (msg.scope === 'group') {
      const room = fileRooms.find(r => r.id === roomId);
      const isPrivate = room && room.is_private;
      if (!isPrivate) {
        const roomMsgs = fileMessages.filter(m => m.scope === 'group' && m.room_id === roomId);
        if (roomMsgs.length > MAX_HISTORY) {
          // 删除该房间最早的超出部分
          const toRemove = roomMsgs.length - MAX_HISTORY;
          let removed = 0;
          fileMessages = fileMessages.filter(m => {
            if (removed < toRemove && m.scope === 'group' && m.room_id === roomId) {
              removed++;
              return false;
            }
            return true;
          });
        }
      }
    }
    saveFile();
    return row;
  }
}

// 撤回消息（标记 revoked=1，清空内容与文件；记录撤回者）
async function revokeMessage(id, by) {
  let fileUrlToDelete = null;
  if (mode === 'mysql') {
    // 先取出 file_url(用于撤回后删除实际文件)
    const [rows] = await pool.query(`SELECT file_url FROM messages WHERE id=? LIMIT 1`, [id]);
    if (rows.length && rows[0].file_url) fileUrlToDelete = rows[0].file_url;
    await pool.query(
      `UPDATE messages SET revoked=1, content='', file_url=NULL, file_name=NULL, revoked_by=? WHERE id=?`,
      [by ? String(by).slice(0, 64) : null, id]
    );
  } else {
    const m = fileMessages.find(x => String(x.id) === String(id));
    if (m) {
      if (m.file && m.file.url) fileUrlToDelete = m.file.url;
      m.revoked = 1;
      m.content = '';
      m.revoked_by = by || null;
      if (m.file) m.file = null;
      saveFile();
    }
  }
  // 异步删除实际文件(R2 或本地),不阻塞撤回操作
  if (fileUrlToDelete) {
    deleteFile(fileUrlToDelete).catch(e => {
      console.error('[storage] 撤回时删除文件失败:', e.message);
    });
  }
}

// 按 id 取单条消息（用于撤回权限校验）
async function getMessageById(id) {
  if (mode === 'mysql') {
    const [rows] = await pool.query(`SELECT * FROM messages WHERE id=? LIMIT 1`, [id]);
    return rows.length ? normalizeRow(rows[0]) : null;
  } else {
    const m = fileMessages.find(x => String(x.id) === String(id));
    return m ? normalizeRow(m) : null;
  }
}

async function getGroupHistory(roomId, limit) {
  limit = limit || MAX_HISTORY;
  const rid = String(roomId || 'default').slice(0, 32);
  if (mode === 'mysql') {
    // 私密房间返回全部历史，公开房间返回最近 limit 条
    const [roomRows] = await pool.query(`SELECT is_private FROM rooms WHERE id=? LIMIT 1`, [rid]);
    const isPrivate = roomRows.length > 0 && roomRows[0].is_private;
    const actualLimit = isPrivate ? 100000 : limit;
    const [rows] = await pool.query(
      `SELECT * FROM messages WHERE scope='group' AND room_id=? ORDER BY time ASC LIMIT ?`,
      [rid, actualLimit]
    );
    return rows.map(normalizeRow);
  } else {
    return fileMessages
      .filter(m => m.scope === 'group' && m.room_id === rid)
      .slice(-limit);
  }
}

async function getPrivateHistory(userA, userB, limit) {
  limit = limit || MAX_HISTORY;
  if (mode === 'mysql') {
    const [rows] = await pool.query(
      `SELECT * FROM messages
       WHERE scope='private'
         AND ((sender=? AND receiver=?) OR (sender=? AND receiver=?))
       ORDER BY time ASC LIMIT ?`,
      [userA, userB, userB, userA, limit]
    );
    return rows.map(normalizeRow);
  } else {
    return fileMessages
      .filter(m => m.scope === 'private' &&
        ((m.sender === userA && m.receiver === userB) ||
         (m.sender === userB && m.receiver === userA)))
      .slice(-limit);
  }
}

// 管理员查询：列出所有有私聊记录的用户对
async function listPrivatePairs(limit) {
  limit = limit || MAX_HISTORY;
  if (mode === 'mysql') {
    const [rows] = await pool.query(
      `SELECT DISTINCT
         LEAST(sender, receiver) AS a,
         GREATEST(sender, receiver) AS b,
         MAX(time) AS last_time
       FROM messages
       WHERE scope='private'
       GROUP BY a, b
       ORDER BY last_time DESC LIMIT ?`, [limit]
    );
    return rows;
  } else {
    const seen = new Map();
    fileMessages.forEach(m => {
      if (m.scope !== 'private') return;
      const a = [m.sender, m.receiver].sort()[0];
      const b = [m.sender, m.receiver].sort()[1];
      const key = a + '|' + b;
      if (!seen.has(key) || seen.get(key) < m.time) seen.set(key, m.time);
    });
    return Array.from(seen.entries())
      .map(([k, t]) => { const [a, b] = k.split('|'); return { a, b, last_time: t }; })
      .sort((x, y) => y.last_time - x.last_time)
      .slice(0, limit);
  }
}

// 查询指定用户的所有私聊会话(含未读数和最后一条消息)
// 返回: [{ peer, last_time, last_content, last_content_type, unread }]
// 未读数 = 对方发给我、且时间 > 我对该会话的最后已读时间 的消息数
async function listPrivateConversations(userName) {
  if (!userName) return [];
  if (mode === 'mysql') {
    // 1. 查出该用户参与的所有私聊会话(按对方分组),取最后一条消息
    const [rows] = await pool.query(
      `SELECT
         CASE WHEN sender=? THEN receiver ELSE sender END AS peer,
         MAX(time) AS last_time
       FROM messages
       WHERE scope='private' AND (sender=? OR receiver=?)
       GROUP BY peer
       ORDER BY last_time DESC`,
      [userName, userName, userName]
    );
    if (rows.length === 0) return [];
    // 2. 查每个会话的最后一条消息内容
    const result = [];
    for (const r of rows) {
      const [lastMsg] = await pool.query(
        `SELECT content, content_type, file_name, file_url, file_size, file_mime, sender, time
         FROM messages
         WHERE scope='private'
           AND ((sender=? AND receiver=?) OR (sender=? AND receiver=?))
           AND revoked=0
         ORDER BY time DESC LIMIT 1`,
        [userName, r.peer, r.peer, userName]
      );
      // 3. 查该会话的未读数(对方发给我、且时间 > 最后已读时间)
      const [readRows] = await pool.query(
        `SELECT last_read_at FROM private_read_status WHERE user_name=? AND peer_name=? LIMIT 1`,
        [userName, r.peer]
      );
      const lastReadAt = readRows.length ? readRows[0].last_read_at : 0;
      const [unreadRows] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM messages
         WHERE scope='private' AND sender=? AND receiver=? AND time > ? AND revoked=0`,
        [r.peer, userName, lastReadAt]
      );
      const lm = lastMsg[0] || {};
      const hasFile = lm.file_url || lm.file_name;
      result.push({
        peer: r.peer,
        last_time: r.last_time,
        last_content: hasFile ? (lm.file_name || '[文件]') : (lm.content || ''),
        last_content_type: lm.content_type || 'text',
        last_sender: lm.sender || '',
        unread: unreadRows[0].cnt || 0
      });
    }
    return result;
  } else {
    // 文件模式
    const peerMap = new Map();
    fileMessages.forEach(m => {
      if (m.scope !== 'private') return;
      if (m.sender !== userName && m.receiver !== userName) return;
      const peer = m.sender === userName ? m.receiver : m.sender;
      if (!peerMap.has(peer) || peerMap.get(peer).last_time < m.time) {
        peerMap.set(peer, {
          peer,
          last_time: m.time,
          last_content: m.file ? (m.file.name || '[文件]') : (m.content || ''),
          last_content_type: m.content_type || 'text',
          last_sender: m.sender || '',
          unread: 0
        });
      }
    });
    // 文件模式未读数计算:基于内存(不持久化,重启后清零)
    // 简化:文件模式不计算未读,返回 0
    return Array.from(peerMap.values()).sort((a, b) => b.last_time - a.last_time);
  }
}

// 标记指定用户对某个会话已读(更新最后已读时间为当前)
async function markPrivateRead(userName, peer) {
  if (!userName || !peer) return;
  const now = Date.now();
  if (mode === 'mysql') {
    await pool.query(
      `INSERT INTO private_read_status (user_name, peer_name, last_read_at)
       VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE last_read_at=VALUES(last_read_at)`,
      [userName, peer, now]
    );
  }
  // 文件模式:不持久化,无操作
}

// ============ 群聊/房间未读 ============

// 标记用户对某房间已读(更新最后已读时间为当前)
async function markRoomRead(userName, roomId) {
  if (!userName || !roomId) return;
  const now = Date.now();
  if (mode === 'mysql') {
    await pool.query(
      `INSERT INTO room_read_status (user_name, room_id, last_read_at)
       VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE last_read_at=VALUES(last_read_at)`,
      [userName, String(roomId).slice(0, 32), now]
    );
  }
  // 文件模式:不持久化,无操作
}

// 计算用户在各房间的未读数
// 返回: { room_id: 未读数, ... }
// 未读数 = 该房间内、非我发送、时间 > 最后已读时间 且未撤回的消息数
async function listRoomUnreads(userName, roomIds) {
  const result = {};
  if (!userName || !roomIds || roomIds.length === 0) return result;
  // 初始化为 0
  roomIds.forEach(rid => { result[rid] = 0; });
  if (mode === 'mysql') {
    const placeholders = roomIds.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT m.room_id, COUNT(*) AS cnt
       FROM messages m
       LEFT JOIN room_read_status r
         ON r.user_name=? AND r.room_id=m.room_id
       WHERE m.scope='group'
         AND m.room_id IN (${placeholders})
         AND m.sender<>?
         AND m.revoked=0
         AND m.time > COALESCE(r.last_read_at, 0)
       GROUP BY m.room_id`,
      [userName, ...roomIds, userName]
    );
    rows.forEach(r => { result[r.room_id] = r.cnt; });
  }
  // 文件模式:未读不持久化,返回全 0
  return result;
}

// 房间被删除时清理该房间的所有已读状态记录
async function clearRoomReadStatus(roomId) {
  if (!roomId) return;
  if (mode === 'mysql') {
    await pool.query(`DELETE FROM room_read_status WHERE room_id=?`, [roomId]);
  }
}

function normalizeRow(r) {
  const file = r.file || (r.file_url ? {
    name: r.file_name, url: r.file_url, size: r.file_size, mime: r.file_mime
  } : null);
  return {
    id: r.id,
    scope: r.scope,
    room_id: r.room_id || 'default',
    sender: r.sender,
    receiver: r.receiver,
    content: r.content,
    content_type: r.content_type || 'text',
    file,
    quote_id: r.quote_id,
    quote: r.quote || (r.q_sender || r.q_content ? {
      id: r.quote_id, sender: r.q_sender, content: r.q_content
    } : null),
    revoked: r.revoked || 0,
    revoked_by: r.revoked_by || null,
    time: r.time
  };
}

// ============ 房间管理 ============
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const BCRYPT_ROUNDS = 10;

// 生成随机房间 ID（防枚举）
function generateRoomId() {
  return 'room_' + crypto.randomBytes(8).toString('hex');
}

// 创建房间
async function createRoom({ name, password, owner, isPrivate, idleTimeoutHours }) {
  const roomId = generateRoomId();
  const roomName = String(name || '').slice(0, 64).trim();
  const roomOwner = String(owner || '').slice(0, 64).trim();
  if (!roomName || !roomOwner) throw new Error('房间名和房主不能为空');
  const passwordHash = password ? await bcrypt.hash(String(password), BCRYPT_ROUNDS) : null;
  const isPriv = isPrivate ? 1 : 0;
  // 空闲超时:前端以分钟输入并换算为小时(小数),支持 1 分钟 ~ 7 天;0/无效则视为不启用
  const parsedTimeout = Number(idleTimeoutHours);
  const idleTimeout = !isPriv && !isNaN(parsedTimeout) && parsedTimeout >= 1 / 60 && parsedTimeout <= 168
    ? Math.round(parsedTimeout * 1000) / 1000
    : null;
  const createdAt = Date.now();

  if (mode === 'mysql') {
    await pool.query(
      `INSERT INTO rooms (id, name, password_hash, owner, is_private, idle_timeout_hours, empty_since, managers, created_at)
       VALUES (?,?,?,?,?,?,NULL,NULL,?)`,
      [roomId, roomName, passwordHash, roomOwner, isPriv, idleTimeout, createdAt]
    );
  } else {
    if (!fileRooms) fileRooms = [];
    fileRooms.push({
      id: roomId, name: roomName, password_hash: passwordHash,
      owner: roomOwner, is_private: isPriv, idle_timeout_hours: idleTimeout,
      empty_since: null, managers: [], created_at: createdAt
    });
    saveRoomsFile();
  }
  return { id: roomId, name: roomName, owner: roomOwner, is_private: isPriv, has_password: !!passwordHash, idle_timeout_hours: idleTimeout, managers: [], created_at: createdAt };
}

// 获取房间信息（不含密码哈希）
async function getRoom(roomId) {
  if (mode === 'mysql') {
    const [rows] = await pool.query(`SELECT * FROM rooms WHERE id=? LIMIT 1`, [roomId]);
    if (rows.length === 0) return null;
    return normalizeRoom(rows[0]);
  } else {
    if (!fileRooms) return null;
    const r = fileRooms.find(x => x.id === roomId);
    return r ? normalizeRoom(r) : null;
  }
}

// 列出所有房间（公开信息）
async function listRooms() {
  if (mode === 'mysql') {
    const [rows] = await pool.query(`SELECT * FROM rooms ORDER BY created_at ASC`);
    return rows.map(normalizeRoom);
  } else {
    if (!fileRooms) return [];
    return fileRooms.map(normalizeRoom);
  }
}

// 校验房间密码
async function verifyRoomPassword(roomId, password) {
  if (mode === 'mysql') {
    const [rows] = await pool.query(`SELECT password_hash FROM rooms WHERE id=? LIMIT 1`, [roomId]);
    if (rows.length === 0) return { exists: false, ok: false };
    const hash = rows[0].password_hash;
    if (!hash) return { exists: true, ok: true }; // 无密码房间
    if (!password) return { exists: true, ok: false };
    const ok = await bcrypt.compare(String(password), hash);
    return { exists: true, ok };
  } else {
    if (!fileRooms) return { exists: false, ok: false };
    const r = fileRooms.find(x => x.id === roomId);
    if (!r) return { exists: false, ok: false };
    if (!r.password_hash) return { exists: true, ok: true };
    if (!password) return { exists: true, ok: false };
    const ok = await bcrypt.compare(String(password), r.password_hash);
    return { exists: true, ok };
  }
}

// 转让房主
async function transferOwner(roomId, newOwner) {
  const owner = String(newOwner || '').slice(0, 64).trim();
  if (!owner) throw new Error('新房主不能为空');
  if (mode === 'mysql') {
    const [res] = await pool.query(`UPDATE rooms SET owner=? WHERE id=?`, [owner, roomId]);
    return res.affectedRows > 0;
  } else {
    if (!fileRooms) return false;
    const r = fileRooms.find(x => x.id === roomId);
    if (r) { r.owner = owner; saveRoomsFile(); return true; }
    return false;
  }
}

// 更新房间（改名/改密码）
async function updateRoom(roomId, { name, password, isPrivate }) {
  const updates = [];
  const params = [];
  if (name !== undefined) {
    updates.push('name=?');
    params.push(String(name).slice(0, 64).trim());
  }
  if (password !== undefined) {
    const hash = password ? await bcrypt.hash(String(password), BCRYPT_ROUNDS) : null;
    updates.push('password_hash=?');
    params.push(hash);
  }
  if (isPrivate !== undefined) {
    updates.push('is_private=?');
    params.push(isPrivate ? 1 : 0);
  }
  if (updates.length === 0) return false;
  params.push(roomId);

  if (mode === 'mysql') {
    const [res] = await pool.query(`UPDATE rooms SET ${updates.join(',')} WHERE id=?`, params);
    return res.affectedRows > 0;
  } else {
    if (!fileRooms) return false;
    const r = fileRooms.find(x => x.id === roomId);
    if (!r) return false;
    if (name !== undefined) r.name = String(name).slice(0, 64).trim();
    if (password !== undefined) r.password_hash = password ? bcrypt.hashSync(String(password), BCRYPT_ROUNDS) : null;
    if (isPrivate !== undefined) r.is_private = isPrivate ? 1 : 0;
    saveRoomsFile();
    return true;
  }
}

// 删除房间（同时删除该房间的消息与消息引用的文件）
async function deleteRoom(roomId) {
  const fileUrls = [];
  if (mode === 'mysql') {
    // 先收集该房间消息引用的文件 URL(用于同步删除实际文件)
    const [rows] = await pool.query(
      `SELECT file_url FROM messages WHERE room_id=? AND file_url IS NOT NULL AND file_url!=''`,
      [roomId]
    );
    rows.forEach(r => { if (r.file_url) fileUrls.push(r.file_url); });
    await pool.query(`DELETE FROM messages WHERE room_id=?`, [roomId]);
    await pool.query(`DELETE FROM rooms WHERE id=?`, [roomId]);
  } else {
    if (fileRooms) {
      const idx = fileRooms.findIndex(x => x.id === roomId);
      if (idx >= 0) fileRooms.splice(idx, 1);
      saveRoomsFile();
    }
    if (fileMessages) {
      fileMessages.forEach(m => {
        if (m.room_id === roomId && m.file && m.file.url) fileUrls.push(m.file.url);
      });
      fileMessages = fileMessages.filter(m => m.room_id !== roomId);
      saveFile();
    }
  }
  // 删除该房间消息引用的文件(消息已删除,这些文件不再被引用)
  if (fileUrls.length > 0) {
    const referenced = await getReferencedFiles();
    for (const url of fileUrls) {
      const fn = extractFileName(url);
      if (fn && !referenced.has(fn)) {
        await deleteFile(url);
      }
    }
  }
  // 从所有用户的已加入房间列表中移除(避免重登后恢复已删除的房间)
  await removeRoomFromAllUsers(roomId);
  // 清理该房间的所有已读状态记录
  await clearRoomReadStatus(roomId);
}

function normalizeRoom(r) {
  let managers = [];
  if (r.managers) {
    try { const arr = typeof r.managers === 'string' ? JSON.parse(r.managers) : r.managers; if (Array.isArray(arr)) managers = arr; } catch (e) {}
  }
  return {
    id: r.id,
    name: r.name,
    owner: r.owner,
    is_private: r.is_private || 0,
    has_password: !!r.password_hash,
    idle_timeout_hours: r.is_private ? null : (r.idle_timeout_hours || null),
    empty_since: r.empty_since || null,
    managers,
    created_at: r.created_at
  };
}

// 设置/取消房间管理成员(按昵称存储,持久保留;退出/断线不影响)
// 返回更新后的管理名单
async function setRoomManager(roomId, name, on) {
  const uname = String(name || '').slice(0, 64).trim();
  if (!uname) throw new Error('用户昵称不能为空');
  const room = await getRoom(roomId);
  if (!room) throw new Error('房间不存在');
  let managers = room.managers || [];
  if (on) {
    if (managers.indexOf(uname) < 0) managers = managers.concat(uname);
  } else {
    managers = managers.filter(n => n !== uname);
  }
  const json = JSON.stringify(managers);
  if (mode === 'mysql') {
    await pool.query(`UPDATE rooms SET managers=? WHERE id=?`, [json, roomId]);
  } else {
    const r = (fileRooms || []).find(x => x.id === roomId);
    if (r) { r.managers = managers; saveRoomsFile(); }
  }
  return managers;
}

// 标记公开房间进入/离开空闲状态
async function updateRoomEmptySince(roomId, emptySince) {
  if (!roomId || roomId === 'default') return;
  const value = emptySince == null ? null : Number(emptySince);
  if (mode === 'mysql') {
    await pool.query(`UPDATE rooms SET empty_since=? WHERE id=? AND is_private=0`, [value, roomId]);
  } else {
    const room = (fileRooms || []).find(r => r.id === roomId);
    if (room && !room.is_private) {
      room.empty_since = value;
      saveRoomsFile();
    }
  }
}

// 查询已达到空闲关闭期限的公开房间
async function listExpiredPublicRooms(now) {
  const current = Number(now) || Date.now();
  if (mode === 'mysql') {
    const [rows] = await pool.query(
      `SELECT * FROM rooms
       WHERE id <> 'default' AND is_private=0
         AND idle_timeout_hours IS NOT NULL
         AND empty_since IS NOT NULL
         AND empty_since + idle_timeout_hours * 3600000 <= ?`,
      [current]
    );
    return rows.map(normalizeRoom);
  }
  return (fileRooms || []).filter(r => r.id !== 'default' && !r.is_private &&
    r.idle_timeout_hours > 0 && r.empty_since &&
    r.empty_since + r.idle_timeout_hours * 3600000 <= current).map(normalizeRoom);
}


// 注册用户: username(登录名,不可改) + nickname(显示名,可改) + password_hash
// 主管理员由 .env 的 ADMIN_NAME/ADMIN_PASSWORD 配置;启动时补录进 users 表
// (见 ensureMainAdmin),使其既可通过"快速进入"也可通过"账号登录"登录
// 子管理员复用 users 表,is_admin=1

// 生成 64 字符随机 token
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// 注册用户
// 返回: { id, username, nickname, is_admin } 或抛出错误
async function registerUser({ username, nickname, password }) {
  const uname = String(username || '').slice(0, 64).trim();
  const nick = String(nickname || '').slice(0, 64).trim();
  const pwd = String(password || '');
  if (!uname) throw new Error('用户名不能为空');
  if (!nick) throw new Error('昵称不能为空');
  // 昵称长度与快速进入保持一致(前端 set_name 截断到 20 字符,避免同名匹配不一致)
  if (nick.length > 20) throw new Error('昵称最多 20 字符');
  if (pwd.length < 6) throw new Error('密码至少 6 位');
  if (pwd.length > 50) throw new Error('密码最多 50 位');
  // 不允许用户名或昵称与主管理员冲突
  const adminName = process.env.ADMIN_NAME || 'admin';
  if (uname === adminName) throw new Error('该用户名为保留用户名');
  if (nick === adminName) throw new Error('该昵称为保留昵称');

  const hash = await bcrypt.hash(pwd, BCRYPT_ROUNDS);
  const createdAt = Date.now();

  if (mode === 'mysql') {
    // 先检查 username 和 nickname 是否已存在(避免依赖唯一约束)
    const [existing] = await pool.query(
      `SELECT username, nickname FROM users WHERE username=? OR nickname=? LIMIT 1`,
      [uname, nick]
    );
    if (existing.length > 0) {
      if (existing[0].username === uname) throw new Error('该用户名已被注册');
      if (existing[0].nickname === nick) throw new Error('该昵称已被使用');
    }
    try {
      const [res] = await pool.query(
        `INSERT INTO users (username, nickname, password_hash, is_admin, created_at, last_login)
         VALUES (?,?,?,?,?,NULL)`,
        [uname, nick, hash, 0, createdAt]
      );
      return { id: res.insertId, username: uname, nickname: nick, is_admin: 0, created_at: createdAt };
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        // 并发场景下的兜底检查
        const [existing2] = await pool.query(`SELECT username, nickname FROM users WHERE username=? OR nickname=? LIMIT 1`, [uname, nick]);
        if (existing2.length > 0) {
          if (existing2[0].username === uname) throw new Error('该用户名已被注册');
          if (existing2[0].nickname === nick) throw new Error('该昵称已被使用');
        }
        throw new Error('用户名或昵称已被占用');
      }
      throw e;
    }
  } else {
    if (fileUsers.find(u => u.username === uname)) throw new Error('该用户名已被注册');
    if (fileUsers.find(u => u.nickname === nick)) throw new Error('该昵称已被使用');
    const id = (fileUsers.length === 0 ? 0 : Math.max(...fileUsers.map(u => u.id))) + 1;
    const user = {
      id, username: uname, nickname: nick, password_hash: hash,
      is_admin: 0, created_at: createdAt, last_login: null
    };
    fileUsers.push(user);
    saveUsersFile();
    return { id, username: uname, nickname: nick, is_admin: 0, created_at: createdAt };
  }
}

// 用户名+密码登录,返回用户对象(不含 password_hash)或 null
async function loginUser({ username, password }) {
  const uname = String(username || '').slice(0, 64).trim();
  if (!uname || !password) return null;
  let user;
  if (mode === 'mysql') {
    const [rows] = await pool.query(`SELECT * FROM users WHERE username=? LIMIT 1`, [uname]);
    if (rows.length === 0) return null;
    user = rows[0];
  } else {
    user = fileUsers.find(u => u.username === uname);
    if (!user) return null;
  }
  const ok = await bcrypt.compare(String(password), user.password_hash);
  if (!ok) return null;
  // 更新最后登录时间
  const now = Date.now();
  if (mode === 'mysql') {
    await pool.query(`UPDATE users SET last_login=? WHERE id=?`, [now, user.id]);
  } else {
    user.last_login = now;
    saveUsersFile();
  }
  return normalizeUser(user);
}

// 通过 token 验证登录态,返回用户对象或 null(过期/不存在)
async function verifyToken(token) {
  const t = String(token || '').slice(0, 64);
  if (!t) return null;
  const now = Date.now();
  let userId;
  if (mode === 'mysql') {
    const [rows] = await pool.query(`SELECT user_id, expires_at FROM sessions WHERE token=? LIMIT 1`, [t]);
    if (rows.length === 0) return null;
    if (rows[0].expires_at < now) {
      // 过期,清除
      await pool.query(`DELETE FROM sessions WHERE token=?`, [t]);
      return null;
    }
    userId = rows[0].user_id;
  } else {
    const sess = fileSessions.find(s => s.token === t);
    if (!sess) return null;
    if (sess.expires_at < now) {
      fileSessions = fileSessions.filter(s => s.token !== t);
      saveSessionsFile();
      return null;
    }
    userId = sess.user_id;
  }
  // 查询用户
  let user;
  if (mode === 'mysql') {
    const [rows] = await pool.query(`SELECT * FROM users WHERE id=? LIMIT 1`, [userId]);
    if (rows.length === 0) return null;
    user = rows[0];
  } else {
    user = fileUsers.find(u => u.id === userId);
    if (!user) return null;
  }
  return normalizeUser(user);
}

// 创建 session(返回 token)
// remember=true: 30 天,false: 24 小时
async function createSession(userId, remember) {
  const token = generateToken();
  const now = Date.now();
  const ttl = remember ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const expiresAt = now + ttl;
  if (mode === 'mysql') {
    await pool.query(
      `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)`,
      [token, userId, now, expiresAt]
    );
  } else {
    fileSessions.push({ token, user_id: userId, created_at: now, expires_at: expiresAt });
    saveSessionsFile();
  }
  return token;
}

// 删除 session(登出)
async function deleteSession(token) {
  const t = String(token || '').slice(0, 64);
  if (!t) return false;
  if (mode === 'mysql') {
    const [res] = await pool.query(`DELETE FROM sessions WHERE token=?`, [t]);
    return res.affectedRows > 0;
  } else {
    const before = fileSessions.length;
    fileSessions = fileSessions.filter(s => s.token !== t);
    if (fileSessions.length !== before) { saveSessionsFile(); return true; }
    return false;
  }
}

// 删除某用户的所有 session(管理员强制下线)
async function deleteUserSessions(userId) {
  if (mode === 'mysql') {
    const [res] = await pool.query(`DELETE FROM sessions WHERE user_id=?`, [userId]);
    return res.affectedRows;
  } else {
    const before = fileSessions.length;
    fileSessions = fileSessions.filter(s => s.user_id !== userId);
    const removed = before - fileSessions.length;
    if (removed > 0) saveSessionsFile();
    return removed;
  }
}

// 修改密码(需验证旧密码)
// 返回 { ok: true } 或 { ok: false, error }
async function changePassword({ userId, oldPassword, newPassword }) {
  const uid = Number(userId);
  if (!uid) return { ok: false, error: '用户不存在' };
  const oldPwd = String(oldPassword || '');
  const newPwd = String(newPassword || '');
  if (newPwd.length < 6) return { ok: false, error: '新密码至少 6 位' };
  if (newPwd.length > 50) return { ok: false, error: '新密码最多 50 位' };
  let user;
  if (mode === 'mysql') {
    const [rows] = await pool.query(`SELECT * FROM users WHERE id=? LIMIT 1`, [uid]);
    if (rows.length === 0) return { ok: false, error: '用户不存在' };
    user = rows[0];
  } else {
    user = fileUsers.find(u => u.id === uid);
    if (!user) return { ok: false, error: '用户不存在' };
  }
  const ok = await bcrypt.compare(oldPwd, user.password_hash);
  if (!ok) return { ok: false, error: '旧密码错误' };
  const hash = await bcrypt.hash(newPwd, BCRYPT_ROUNDS);
  if (mode === 'mysql') {
    await pool.query(`UPDATE users SET password_hash=? WHERE id=?`, [hash, uid]);
  } else {
    user.password_hash = hash;
    saveUsersFile();
  }
  return { ok: true };
}

// 清理过期 session(可定期调用)
async function cleanExpiredSessions() {
  const now = Date.now();
  if (mode === 'mysql') {
    const [res] = await pool.query(`DELETE FROM sessions WHERE expires_at < ?`, [now]);
    return res.affectedRows;
  } else {
    const before = fileSessions.length;
    fileSessions = fileSessions.filter(s => s.expires_at >= now);
    const removed = before - fileSessions.length;
    if (removed > 0) saveSessionsFile();
    return removed;
  }
}

// 通过 username 查找用户(用于子管理员管理)
async function getUserByUsername(username) {
  const uname = String(username || '').slice(0, 64).trim();
  if (!uname) return null;
  let user;
  if (mode === 'mysql') {
    const [rows] = await pool.query(`SELECT * FROM users WHERE username=? LIMIT 1`, [uname]);
    if (rows.length === 0) return null;
    user = rows[0];
  } else {
    user = fileUsers.find(u => u.username === uname);
    if (!user) return null;
  }
  return normalizeUser(user);
}

// 通过 id 查找用户
async function getUserById(id) {
  let user;
  if (mode === 'mysql') {
    const [rows] = await pool.query(`SELECT * FROM users WHERE id=? LIMIT 1`, [id]);
    if (rows.length === 0) return null;
    user = rows[0];
  } else {
    user = fileUsers.find(u => u.id === id);
    if (!user) return null;
  }
  return normalizeUser(user);
}

// 通过 nickname 查找用户
async function getUserByNickname(nickname) {
  const nick = String(nickname || '').slice(0, 64).trim();
  if (!nick) return null;
  let user;
  if (mode === 'mysql') {
    const [rows] = await pool.query(`SELECT * FROM users WHERE nickname=? LIMIT 1`, [nick]);
    if (rows.length === 0) return null;
    user = rows[0];
  } else {
    user = fileUsers.find(u => u.nickname === nick);
    if (!user) return null;
  }
  return normalizeUser(user);
}

// 列出所有子管理员(is_admin=1,不含主管理员)
async function listAdmins() {
  const adminName = process.env.ADMIN_NAME || 'admin';
  if (mode === 'mysql') {
    const [rows] = await pool.query(
      `SELECT id, username, nickname, created_at FROM users WHERE is_admin=1 AND username<>? ORDER BY created_at ASC`,
      [adminName]
    );
    return rows.map(r => ({ id: r.id, username: r.username, name: r.nickname, created_at: r.created_at }));
  } else {
    return fileUsers
      .filter(u => u.is_admin === 1 && u.username !== adminName)
      .map(u => ({ id: u.id, username: u.username, name: u.nickname, created_at: u.created_at }));
  }
}

// 列出所有注册用户(不含 password_hash)
async function listUsers() {
  if (mode === 'mysql') {
    const [rows] = await pool.query(`SELECT * FROM users ORDER BY created_at ASC`);
    return rows.map(normalizeUser);
  } else {
    return (fileUsers || []).map(normalizeUser);
  }
}

// ============ 用户已加入房间持久化 ============
// 用于注册用户退出登录/换设备后重新登录时恢复已加入的房间。
// joined_rooms 字段存 JSON 数组: ["room_xxx", ...]

// 解析 joined_rooms 字段(容错)
function parseJoinedRooms(val) {
  if (!val) return [];
  try {
    const arr = JSON.parse(val);
    return Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : [];
  } catch (e) { return []; }
}

// 读取用户已加入的房间 ID 列表
async function getUserJoinedRooms(userId) {
  if (!userId) return [];
  if (mode === 'mysql') {
    const [rows] = await pool.query(`SELECT joined_rooms FROM users WHERE id=? LIMIT 1`, [userId]);
    return rows.length ? parseJoinedRooms(rows[0].joined_rooms) : [];
  } else {
    const u = (fileUsers || []).find(x => x.id === userId);
    return u ? parseJoinedRooms(u.joined_rooms) : [];
  }
}

// 记录用户加入一个房间
async function addUserRoom(userId, roomId) {
  if (!userId || !roomId || roomId === 'default') return;
  const list = await getUserJoinedRooms(userId);
  if (list.indexOf(roomId) >= 0) return; // 已记录
  list.push(roomId);
  const json = JSON.stringify(list);
  if (mode === 'mysql') {
    await pool.query(`UPDATE users SET joined_rooms=? WHERE id=?`, [json, userId]);
  } else {
    const u = (fileUsers || []).find(x => x.id === userId);
    if (u) { u.joined_rooms = json; saveUsersFile(); }
  }
}

// 记录用户离开一个房间
async function removeUserRoom(userId, roomId) {
  if (!userId || !roomId) return;
  const list = await getUserJoinedRooms(userId);
  const next = list.filter(x => x !== roomId);
  if (next.length === list.length) return; // 无变化
  const json = JSON.stringify(next);
  if (mode === 'mysql') {
    await pool.query(`UPDATE users SET joined_rooms=? WHERE id=?`, [json, userId]);
  } else {
    const u = (fileUsers || []).find(x => x.id === userId);
    if (u) { u.joined_rooms = json; saveUsersFile(); }
  }
}

// 房间被删除/清理时,从所有用户的已加入列表中移除该房间
async function removeRoomFromAllUsers(roomId) {
  if (!roomId) return;
  if (mode === 'mysql') {
    const [rows] = await pool.query(`SELECT id, joined_rooms FROM users WHERE joined_rooms IS NOT NULL AND joined_rooms!=''`);
    for (const r of rows) {
      const list = parseJoinedRooms(r.joined_rooms);
      const next = list.filter(x => x !== roomId);
      if (next.length !== list.length) {
        await pool.query(`UPDATE users SET joined_rooms=? WHERE id=?`, [JSON.stringify(next), r.id]);
      }
    }
  } else {
    let changed = false;
    for (const u of (fileUsers || [])) {
      const list = parseJoinedRooms(u.joined_rooms);
      const next = list.filter(x => x !== roomId);
      if (next.length !== list.length) { u.joined_rooms = JSON.stringify(next); changed = true; }
    }
    if (changed) saveUsersFile();
  }
}

// 升级为子管理员(通过 username 查找)
async function addAdmin(username) {
  const uname = String(username || '').slice(0, 64).trim();
  if (!uname) throw new Error('用户名不能为空');
  if (uname === (process.env.ADMIN_NAME || 'admin')) throw new Error('不能操作主管理员');
  if (mode === 'mysql') {
    const [res] = await pool.query(`UPDATE users SET is_admin=1 WHERE username=?`, [uname]);
    if (res.affectedRows === 0) throw new Error('用户不存在');
  } else {
    const u = fileUsers.find(x => x.username === uname);
    if (!u) throw new Error('用户不存在');
    u.is_admin = 1;
    saveUsersFile();
  }
  return true;
}

// 降级子管理员(撤销管理员权限)
async function removeAdmin(username) {
  const uname = String(username || '').slice(0, 64).trim();
  if (!uname) return false;
  if (uname === (process.env.ADMIN_NAME || 'admin')) throw new Error('不能操作主管理员');
  if (mode === 'mysql') {
    const [res] = await pool.query(`UPDATE users SET is_admin=0 WHERE username=? AND is_admin=1`, [uname]);
    return res.affectedRows > 0;
  } else {
    const u = fileUsers.find(x => x.username === uname);
    if (!u || u.is_admin !== 1) return false;
    u.is_admin = 0;
    saveUsersFile();
    return true;
  }
}

// 统一用户对象格式(不返回 password_hash)
function normalizeUser(u) {
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname,
    is_admin: u.is_admin === 1 || u.is_admin === true ? 1 : 0,
    created_at: u.created_at,
    last_login: u.last_login
  };
}

async function init() {
  if (process.env.USE_MYSQL === 'true' || process.env.USE_MYSQL === '1') {
    try {
      mode = 'mysql';
      await initMysql();
    } catch (e) {
      console.warn('[storage] MySQL 连接失败，回退到文件模式:', e.message);
      mode = 'file';
      loadFile();
    }
  } else {
    console.log('[storage] 使用文件模式：', MESSAGES_FILE);
  }
  // 将主管理员(.env 的 ADMIN_NAME/ADMIN_PASSWORD)注册为账户,使其可通过"账号登录"登录
  await ensureMainAdmin();
}

// 主管理员默认不在 users 表;启动时补录为账户(username=昵称=ADMIN_NAME,is_admin=1)
// 密码用 bcrypt 哈希存储,并随 .env 的 ADMIN_PASSWORD 变化自动同步
async function ensureMainAdmin() {
  const adminName = String(process.env.ADMIN_NAME || 'admin').slice(0, 64).trim();
  const adminPassword = String(process.env.ADMIN_PASSWORD || '');
  if (!adminName || !adminPassword) return; // 未配置密码时管理员功能关闭
  const hash = await bcrypt.hash(adminPassword, BCRYPT_ROUNDS);
  const createdAt = Date.now();
  if (mode === 'mysql') {
    const [existing] = await pool.query(`SELECT * FROM users WHERE username=? LIMIT 1`, [adminName]);
    if (existing.length === 0) {
      await pool.query(
        `INSERT INTO users (username, nickname, password_hash, is_admin, created_at, last_login)
         VALUES (?,?,?,1,?,NULL)`,
        [adminName, adminName, hash, createdAt]
      );
      console.log(`[storage] 主管理员 ${adminName} 已注册为账户`);
    } else {
      const u = existing[0];
      const passwordChanged = !(await bcrypt.compare(adminPassword, u.password_hash));
      if (passwordChanged || u.is_admin !== 1) {
        await pool.query(
          `UPDATE users SET is_admin=1${passwordChanged ? ', password_hash=?' : ''} WHERE id=?`,
          passwordChanged ? [hash, u.id] : [u.id]
        );
        console.log(`[storage] 主管理员 ${adminName} 账户信息已同步`);
      }
    }
  } else {
    const existing = fileUsers.find(u => u.username === adminName);
    if (!existing) {
      const id = (fileUsers.length === 0 ? 0 : Math.max(...fileUsers.map(u => u.id))) + 1;
      fileUsers.push({
        id, username: adminName, nickname: adminName, password_hash: hash,
        is_admin: 1, created_at: createdAt, last_login: null
      });
      saveUsersFile();
      console.log(`[storage] 主管理员 ${adminName} 已注册为账户`);
    } else if (existing.is_admin !== 1 || !(await bcrypt.compare(adminPassword, existing.password_hash))) {
      existing.is_admin = 1;
      existing.password_hash = hash;
      saveUsersFile();
      console.log(`[storage] 主管理员 ${adminName} 账户信息已同步`);
    }
  }
}

function getMode() { return mode; }

// ============ 清理功能 ============
const fsExtra = require('fs');
const pathExtra = require('path');
const UPLOADS_DIR = pathExtra.join(__dirname, 'public', 'uploads');

// 统计信息：返回各表/目录的统计
async function getStats() {
  if (mode === 'mysql') {
    const [msgCount] = await pool.query(`SELECT COUNT(*) AS c FROM messages`);
    const [revokedCount] = await pool.query(`SELECT COUNT(*) AS c FROM messages WHERE revoked=1`);
    const [roomCount] = await pool.query(`SELECT COUNT(*) AS c FROM rooms`);
    const [groupCount] = await pool.query(`SELECT COUNT(*) AS c FROM messages WHERE scope='group'`);
    const [privateCount] = await pool.query(`SELECT COUNT(*) AS c FROM messages WHERE scope='private'`);
    const [fileCount] = await pool.query(`SELECT COUNT(*) AS c FROM messages WHERE file_url IS NOT NULL AND file_url!=''`);
    return {
      messages: msgCount[0].c,
      revoked: revokedCount[0].c,
      rooms: roomCount[0].c,
      group_messages: groupCount[0].c,
      private_messages: privateCount[0].c,
      file_messages: fileCount[0].c,
      disk_files: countDiskFiles(),
      disk_size: getDiskSize()
    };
  } else {
    return {
      messages: fileMessages.length,
      revoked: fileMessages.filter(m => m.revoked).length,
      rooms: fileRooms.length,
      group_messages: fileMessages.filter(m => m.scope === 'group').length,
      private_messages: fileMessages.filter(m => m.scope === 'private').length,
      file_messages: fileMessages.filter(m => m.file && m.file.url).length,
      disk_files: countDiskFiles(),
      disk_size: getDiskSize()
    };
  }
}

function countDiskFiles() {
  try {
    if (!fsExtra.existsSync(UPLOADS_DIR)) return 0;
    return fsExtra.readdirSync(UPLOADS_DIR).filter(f => {
      const s = fsExtra.statSync(pathExtra.join(UPLOADS_DIR, f));
      return s.isFile();
    }).length;
  } catch (e) { return 0; }
}

function getDiskSize() {
  try {
    if (!fsExtra.existsSync(UPLOADS_DIR)) return 0;
    let total = 0;
    fsExtra.readdirSync(UPLOADS_DIR).forEach(f => {
      try {
        const s = fsExtra.statSync(pathExtra.join(UPLOADS_DIR, f));
        if (s.isFile()) total += s.size;
      } catch (e) {}
    });
    return total;
  } catch (e) { return 0; }
}

// 列出所有上传文件名
function listDiskFiles() {
  try {
    if (!fsExtra.existsSync(UPLOADS_DIR)) return [];
    return fsExtra.readdirSync(UPLOADS_DIR).filter(f => {
      try {
        return fsExtra.statSync(pathExtra.join(UPLOADS_DIR, f)).isFile();
      } catch (e) { return false; }
    });
  } catch (e) { return []; }
}

// 删除磁盘文件(本地模式)
function deleteDiskFile(filename) {
  try {
    const p = pathExtra.join(UPLOADS_DIR, pathExtra.basename(filename));
    if (fsExtra.existsSync(p)) {
      fsExtra.unlinkSync(p);
      return true;
    }
  } catch (e) {}
  return false;
}

// 删除 R2 文件(异步,根据 URL 提取 key 后调用 r2.deleteFromR2)
// 返回 true 表示已发起删除(不等待结果),false 表示未处理
async function deleteR2File(fileUrl) {
  try {
    const r2 = require('./r2');
    if (!r2.isR2Enabled()) return false;
    const key = extractFileName(fileUrl);
    if (!key) return false;
    await r2.deleteFromR2(key);
    return true;
  } catch (e) {
    console.error('[storage] 删除 R2 文件失败:', e.message);
    return false;
  }
}

// 统一的文件删除入口:根据 URL 判断删本地还是删 R2
// fileUrl: 完整 URL 或文件名(本地模式可能传文件名)
// 返回 true 表示删除成功
async function deleteFile(fileUrl) {
  if (!fileUrl) return false;
  // R2 URL(https:// 开头)
  if (String(fileUrl).startsWith('http')) {
    return await deleteR2File(fileUrl);
  }
  // 本地 URL(/uploads/xxx 或纯文件名)
  return deleteDiskFile(fileUrl);
}

// 从 file_url 提取文件名/R2 key
// 支持格式:
//   /uploads/xxx.png          (本地模式)
//   https://img.torasu.xyz/xxx.png  (R2 自定义域名)
//   https://pub-xxx.r2.dev/xxx.png  (R2 开发 URL)
function extractFileName(url) {
  if (!url) return null;
  const s = String(url);
  // R2 URL: https:// 开头,取最后一段路径作为 key
  if (s.startsWith('http')) {
    const m = s.match(/\/([^\/?#]+)$/);
    return m ? m[1] : null;
  }
  // 本地 URL: /uploads/xxx.png
  const m = s.match(/\/uploads\/([^\/?#]+)/);
  return m ? m[1] : null;
}

// 1. 清理旧消息：删除 N 天前的消息（默认 30 天）
async function cleanOldMessages(days) {
  days = parseInt(days, 10) || 30;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let orphanFileUrls = [];  // 完整 URL(R2 模式需要 URL 来判断删除目标)

  if (mode === 'mysql') {
    // 先找出要删除的消息中的文件 URL（用于清理孤儿文件）
    const [rows] = await pool.query(
      `SELECT file_url FROM messages WHERE time < ? AND file_url IS NOT NULL AND file_url!=''`,
      [cutoff]
    );
    rows.forEach(r => {
      if (r.file_url) orphanFileUrls.push(r.file_url);
    });
    const [res] = await pool.query(`DELETE FROM messages WHERE time < ?`, [cutoff]);
    deleted = res.affectedRows;
  } else {
    const before = fileMessages.length;
    const toDelete = fileMessages.filter(m => m.time < cutoff);
    toDelete.forEach(m => {
      if (m.file && m.file.url) orphanFileUrls.push(m.file.url);
    });
    fileMessages = fileMessages.filter(m => m.time >= cutoff);
    deleted = before - fileMessages.length;
    saveFile();
  }

  // 删除孤儿文件（只删除不再被任何消息引用的）
  let filesDeleted = 0;
  if (orphanFileUrls.length > 0) {
    const referenced = await getReferencedFiles();  // Set<filename>
    for (const url of orphanFileUrls) {
      const fn = extractFileName(url);
      if (fn && !referenced.has(fn)) {
        if (await deleteFile(url)) filesDeleted++;
      }
    }
  }

  return { deleted_messages: deleted, deleted_files: filesDeleted, days };
}

// 2. 清理已撤回消息 + 孤儿文件
async function cleanRevokedAndOrphans() {
  let deletedMsgs = 0;
  let filesDeleted = 0;

  // 本地模式:扫描磁盘文件,找不被引用的孤儿
  // R2 模式:从数据库查所有 file_url,找不被引用的(无法列举 R2 中的所有对象)
  const referencedBefore = await getReferencedFiles();  // Set<filename>
  let orphanFileUrls = [];  // 要删除的完整 URL 列表

  // 从撤回消息中收集要删除的文件 URL
  if (mode === 'mysql') {
    const [revokedRows] = await pool.query(
      `SELECT file_url FROM messages WHERE revoked=1 AND file_url IS NOT NULL AND file_url!=''`
    );
    revokedRows.forEach(r => {
      if (r.file_url) orphanFileUrls.push(r.file_url);
    });
  } else {
    fileMessages.forEach(m => {
      if (m.revoked && m.file && m.file.url) orphanFileUrls.push(m.file.url);
    });
  }

  // 本地模式:额外扫描磁盘上的孤儿文件(磁盘上有但数据库不引用的)
  // R2 模式:无法列举 bucket 中所有对象,只能靠撤回消息和旧消息清理来删除
  const r2 = require('./r2');
  if (!r2.isR2Enabled()) {
    const diskFiles = listDiskFiles();
    diskFiles.forEach(fn => {
      if (!referencedBefore.has(fn)) {
        orphanFileUrls.push('/uploads/' + fn);  // 本地 URL 格式
      }
    });
  }

  // 删除已撤回的消息记录
  if (mode === 'mysql') {
    const [res] = await pool.query(`DELETE FROM messages WHERE revoked=1`);
    deletedMsgs = res.affectedRows;
  } else {
    const before = fileMessages.length;
    fileMessages = fileMessages.filter(m => !m.revoked);
    deletedMsgs = before - fileMessages.length;
    saveFile();
  }

  // 删除孤儿文件(只删除不再被任何消息引用的)
  for (const url of orphanFileUrls) {
    const fn = extractFileName(url);
    if (fn && !referencedBefore.has(fn)) {
      if (await deleteFile(url)) filesDeleted++;
    }
  }

  return { deleted_messages: deletedMsgs, deleted_files: filesDeleted };
}

// 获取所有被消息引用的文件名集合
async function getReferencedFiles() {
  const set = new Set();
  if (mode === 'mysql') {
    const [rows] = await pool.query(`SELECT file_url FROM messages WHERE file_url IS NOT NULL AND file_url!=''`);
    rows.forEach(r => {
      const fn = extractFileName(r.file_url);
      if (fn) set.add(fn);
    });
  } else {
    fileMessages.forEach(m => {
      if (m.file && m.file.url) {
        const fn = extractFileName(m.file.url);
        if (fn) set.add(fn);
      }
    });
  }
  return set;
}

// 3. 清理孤儿房间：无房主或房主昵称不存在的房间（保留 default）
async function cleanOrphanRooms() {
  const rooms = await listRooms();
  let deletedRooms = [];
  let deletedMessages = 0;
  const orphanFileUrls = [];  // 被删房间消息引用的文件 URL

  for (const room of rooms) {
    if (room.id === 'default') continue;
    // 孤儿房间条件：房主为空
    if (!room.owner || room.owner.trim() === '') {
      if (mode === 'mysql') {
        const [rows] = await pool.query(
          `SELECT file_url FROM messages WHERE room_id=? AND file_url IS NOT NULL AND file_url!=''`,
          [room.id]
        );
        rows.forEach(r => { if (r.file_url) orphanFileUrls.push(r.file_url); });
        const [res] = await pool.query(`DELETE FROM messages WHERE room_id=?`, [room.id]);
        deletedMessages += res.affectedRows;
        await pool.query(`DELETE FROM rooms WHERE id=?`, [room.id]);
      } else {
        const before = fileMessages.length;
        fileMessages.forEach(m => {
          if (m.room_id === room.id && m.file && m.file.url) orphanFileUrls.push(m.file.url);
        });
        fileMessages = fileMessages.filter(m => m.room_id !== room.id);
        deletedMessages += before - fileMessages.length;
        const idx = fileRooms.findIndex(r => r.id === room.id);
        if (idx >= 0) fileRooms.splice(idx, 1);
        saveFile();
        saveRoomsFile();
      }
      deletedRooms.push(room.name + ' (' + room.id + ')');
        await removeRoomFromAllUsers(room.id);
        await clearRoomReadStatus(room.id);
      }
  }
  // 删除被删房间消息引用的文件(消息已删除,这些文件不再被引用)
  let filesDeleted = 0;
  if (orphanFileUrls.length > 0) {
    const referenced = await getReferencedFiles();
    for (const url of orphanFileUrls) {
      const fn = extractFileName(url);
      if (fn && !referenced.has(fn)) {
        if (await deleteFile(url)) filesDeleted++;
      }
    }
  }
  return { deleted_rooms: deletedRooms.length, deleted_messages: deletedMessages, deleted_files: filesDeleted, rooms: deletedRooms };
}

// 4. 完全重置数据库（危险操作）
async function resetDatabase() {
  if (mode === 'mysql') {
    await pool.query(`DELETE FROM messages`);
    await pool.query(`DELETE FROM rooms WHERE id!='default'`);
    await pool.query(`DELETE FROM sessions`);
    await pool.query(`UPDATE users SET joined_rooms=NULL`); // 房间全清空,已加入记录失效
    await pool.query(`DELETE FROM room_read_status`); // 房间未读状态全清空
    await pool.query(`DELETE FROM private_read_status`); // 私聊已读状态全清空
    await pool.query(`DELETE FROM users`);
    // 重置 default 房间信息
    await pool.query(
      `UPDATE rooms SET name='公共大厅', password_hash=NULL, owner='', is_private=0 WHERE id='default'`
    );
  } else {
    fileMessages = [];
    fileRooms = [{
      id: 'default', name: '公共大厅', password_hash: null,
      owner: '', is_private: 0, created_at: Date.now()
    }];
    fileUsers = [];
    fileSessions = [];
    saveFile();
    saveRoomsFile();
    saveUsersFile();
    saveSessionsFile();
  }
  // 清空上传目录
  let filesDeleted = 0;
  const diskFiles = listDiskFiles();
  diskFiles.forEach(fn => {
    if (deleteDiskFile(fn)) filesDeleted++;
  });
  // 重置后重新注册主管理员账户
  await ensureMainAdmin();
  return { deleted_messages: 'all', deleted_rooms: 'all_except_default', deleted_files: filesDeleted };
}

// ---------- 上传记录(可追溯性) ----------
function normalizeUpload(r) {
  return {
    id: r.id,
    file_name: r.file_name,
    file_url: r.file_url,
    uploader: r.uploader,
    user_id: r.user_id,
    ip: r.ip,
    size: r.size,
    mime: r.mime,
    is_image: !!r.is_image,
    room_id: r.room_id,
    created_at: r.created_at
  };
}
// 记录一次文件上传:保存文件名、URL、上传者、用户ID、IP、大小等信息,便于事后追责
async function recordUpload(data) {
  const rec = {
    file_name: String(data.file_name || '').slice(0, 255),
    file_url: String(data.file_url || '').slice(0, 500),
    uploader: String(data.uploader || '').slice(0, 64),
    user_id: data.user_id || null,
    ip: String(data.ip || '').slice(0, 64),
    size: parseInt(data.size, 10) || 0,
    mime: String(data.mime || '').slice(0, 128),
    is_image: data.is_image ? 1 : 0,
    room_id: String(data.room_id || '').slice(0, 32),
    created_at: Date.now()
  };
  if (mode === 'mysql') {
    await pool.query(
      `INSERT INTO uploads (file_name, file_url, uploader, user_id, ip, size, mime, is_image, room_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [rec.file_name, rec.file_url, rec.uploader, rec.user_id, rec.ip, rec.size, rec.mime, rec.is_image, rec.room_id, rec.created_at]
    );
  } else {
    fileUploads.push(rec);
    saveUploadsFile();
  }
  return rec;
}
// 查询上传记录(按时间倒序,支持按文件名/上传者/IP/URL 搜索)
async function listUploads({ limit = 200, kw = '' } = {}) {
  const n = Math.max(1, Math.min(parseInt(limit, 10) || 200, 500));
  const key = String(kw || '').trim();
  if (mode === 'mysql') {
    let rows;
    if (key) {
      const like = '%' + key + '%';
      [rows] = await pool.query(
        `SELECT * FROM uploads WHERE file_name LIKE ? OR uploader LIKE ? OR ip LIKE ? OR file_url LIKE ? ORDER BY id DESC LIMIT ?`,
        [like, like, like, like, n]
      );
    } else {
      [rows] = await pool.query(`SELECT * FROM uploads ORDER BY id DESC LIMIT ?`, [n]);
    }
    return rows.map(normalizeUpload);
  } else {
    let arr = fileUploads.slice().reverse();
    if (key) {
      const k = key.toLowerCase();
      arr = arr.filter(r =>
        (r.file_name || '').toLowerCase().includes(k) ||
        (r.uploader || '').toLowerCase().includes(k) ||
        (r.ip || '').toLowerCase().includes(k) ||
        (r.file_url || '').toLowerCase().includes(k)
      );
    }
    return arr.slice(0, n);
  }
}

module.exports = {
  init, addMessage, revokeMessage, getMessageById,
  getGroupHistory, getPrivateHistory, listPrivatePairs, getMode,
  createRoom, getRoom, listRooms, verifyRoomPassword,
  transferOwner, updateRoom, deleteRoom, setRoomManager,
  updateRoomEmptySince, listExpiredPublicRooms,
  getStats, cleanOldMessages, cleanRevokedAndOrphans, cleanOrphanRooms, resetDatabase,
  // 上传记录(可追溯性)
  recordUpload, listUploads,
  // 用户与登录管理
  registerUser, loginUser, verifyToken, createSession, deleteSession,
  deleteUserSessions, cleanExpiredSessions, changePassword,
  getUserByUsername, getUserById, getUserByNickname,
  // 子管理员管理(基于 users 表)
  listAdmins, addAdmin, removeAdmin,
  // 用户列表
  listUsers,
  // 用户已加入房间持久化
  getUserJoinedRooms, addUserRoom, removeUserRoom, removeRoomFromAllUsers,
  // 私聊会话与已读状态
  listPrivateConversations, markPrivateRead,
  // 群聊/房间已读状态
  markRoomRead, listRoomUnreads, clearRoomReadStatus
};
