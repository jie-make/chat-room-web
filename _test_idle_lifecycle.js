// 动态监控: 创建(idle=1h) -> join -> 离开 -> 断线 各阶段 empty_since 变化
const WebSocket = require('ws');
require('dotenv').config();
const mysql = require('mysql2/promise');
const URL = 'ws://localhost:3000';
const ts = Date.now();
function send(ws,obj){ws.send(JSON.stringify(obj));}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

function attachQueue(ws) {
  const queue = [], waiters = [];
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (waiters.length > 0) waiters.shift().resolve(msg); else queue.push(msg);
  });
  function waitMsg(timeout = 5000) {
    return new Promise((resolve) => {
      if (queue.length > 0) { resolve(queue.shift()); return; }
      const w = { resolve };
      waiters.push(w);
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); resolve(null); } }, timeout);
    });
  }
  return { waitMsg };
}
async function newWs() {
  const ws = new WebSocket(URL);
  await new Promise(r => ws.on('open', r));
  const { waitMsg } = attachQueue(ws);
  ws.waitMsg = waitMsg;
  return ws;
}
async function waitType(ws, type, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const msg = await ws.waitMsg(timeout - (Date.now() - start));
    if (!msg) return null;
    if (msg.type === type) return msg;
  }
  return null;
}

(async () => {
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'chat_db'
  });
  async function dbState(roomId) {
    const [r] = await pool.query(`SELECT idle_timeout_hours, empty_since FROM rooms WHERE id=?`, [roomId]);
    return r[0] || null;
  }

  const jie = await newWs();
  send(jie, { type: 'login', username: 'jie', password: '299427', remember: true });
  await waitType(jie, 'login_result');

  console.log('[1] 创建房间(idle=1h)后(未join)');
  send(jie, { type: 'create_room', name: 'dbg' + ts, password: '', is_private: false, idle_timeout_hours: 1 });
  const rc = await waitType(jie, 'room_created', 4000);
  const rid = rc.room.id;
  console.log('    DB:', JSON.stringify(await dbState(rid)));

  console.log('[2] join 之后');
  send(jie, { type: 'join_room', room_id: rid, password: '' });
  await waitType(jie, 'room_joined', 4000);
  console.log('    DB:', JSON.stringify(await dbState(rid)));

  console.log('[3] 离开房间之后');
  send(jie, { type: 'leave_room', room_id: rid });
  await waitType(jie, 'room_left', 4000);
  console.log('    DB:', JSON.stringify(await dbState(rid)));

  console.log('[4] 断线之后');
  jie.close();
  await sleep(800);
  console.log('    DB:', JSON.stringify(await dbState(rid)));

  // 手动验证过期查询(用当前时间)
  const [exp] = await pool.query(
    `SELECT id FROM rooms WHERE id=? AND empty_since IS NOT NULL AND empty_since + idle_timeout_hours * 3600000 <= ?`,
    [rid, Date.now()]);
  console.log('[5] 当前是否命中过期查询:', exp.length > 0 ? '命中(会被清理)' : '未命中(正常)');

  // 清理测试房间
  await pool.query(`DELETE FROM messages WHERE room_id=?`, [rid]);
  await pool.query(`DELETE FROM rooms WHERE id=?`, [rid]);
  console.log('测试房间已清理');
  await pool.end();
  process.exit(0);
})();
