// 验证:注册用户退出登录再登录后,自动恢复已加入的房间(服务端持久化)
const WebSocket = require('ws');
const BASE = 'ws://127.0.0.1:3000';
let passed = 0, failed = 0;
function log(ok, name, detail) {
  if (ok) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')); }
}
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
function waitMsg(ws, type, timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { ws.off('message', onMsg); resolve(null); }, timeout || 8000);
    function onMsg(raw) {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (m.type === type) { clearTimeout(timer); ws.off('message', onMsg); resolve(m); }
    }
    ws.on('message', onMsg);
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const t = Date.now().toString().slice(-8);
  const username = 'u_' + t;
  const nickname = '持久化_' + t;
  const roomName = '恢复房间_' + t;

  // 1. 注册用户
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'register', username, nickname, password: 'pass123456', remember: false }));
  const reg = await waitMsg(ws, 'register_result');
  log(!!reg && reg.ok, '注册用户: ' + username + '/' + nickname, reg ? (reg.ok ? '' : reg.error) : '无响应');
  if (!reg || !reg.ok) process.exit(1);
  const token = reg.token;
  const userId = reg.user_id;
  await waitMsg(ws, 'name_set');

  // 2. 创建房间并加入
  ws.send(JSON.stringify({ type: 'create_room', name: roomName, password: '', is_private: false, idle_timeout_hours: null }));
  const created = await waitMsg(ws, 'room_created');
  log(!!created, '创建房间: ' + roomName);
  if (!created) process.exit(1);
  const roomId = created.room.id;
  ws.send(JSON.stringify({ type: 'join_room', room_id: roomId, password: '' }));
  const joined = await waitMsg(ws, 'room_joined');
  log(!!joined && joined.room.id === roomId, '加入房间');
  await sleep(300); // 等待 addUserRoom 落库

  // 3. 登出
  ws.send(JSON.stringify({ type: 'logout' }));
  const loggedOut = await waitMsg(ws, 'logged_out');
  log(!!loggedOut, '登出');
  ws.close();
  await sleep(300);

  // 4. 直接查库确认 joined_rooms 已持久化
  const mysql = require('mysql2/promise');
  const c = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'root', password: '299427', database: 'chat_db' });
  const [rows] = await c.query('SELECT joined_rooms FROM users WHERE id=?', [userId]);
  const saved = rows.length ? (rows[0].joined_rooms || '[]') : '[]';
  log(saved.indexOf(roomId) >= 0, '服务端已持久化该房间(DB joined_rooms)', saved);
  await c.end();

  // 5. 重新登录(用户名+密码,模拟登出后重新登录)
  const ws2 = await connect();
  ws2.send(JSON.stringify({ type: 'login', username, password: 'pass123456', remember: false }));
  const login = await waitMsg(ws2, 'login_result');
  log(!!login && login.ok, '重新登录(用户名+密码)');
  if (!login || !login.ok) { console.log('  登录失败:', login && login.error); process.exit(1); }
  const token2 = login.token;
  await waitMsg(ws2, 'name_set');

  // 6. 请求 joined_rooms,应返回该房间(服务端持久化合并)
  ws2.send(JSON.stringify({ type: 'joined_rooms' }));
  const jr = await waitMsg(ws2, 'joined_rooms');
  const inList = jr && jr.data && jr.data.some(r => r.id === roomId);
  log(!!inList, '重新登录后 joined_rooms 包含该房间',
    jr ? jr.data.map(r => r.id).join(',') : '无响应');

  // 7. 模拟前端恢复:对持久化房间发送 silent join
  ws2.send(JSON.stringify({ type: 'join_room', room_id: roomId, password: '', silent: true }));
  const j2 = await waitMsg(ws2, 'room_joined');
  log(!!j2 && j2.room.id === roomId, 'silent join 恢复成功');

  // 8. 离开房间后重新登录,不应再恢复该房间
  ws2.send(JSON.stringify({ type: 'leave_room', room_id: roomId }));
  const left = await waitMsg(ws2, 'room_left');
  log(!!left, '离开房间');
  await sleep(300);
  ws2.send(JSON.stringify({ type: 'logout' }));
  await waitMsg(ws2, 'logged_out');
  ws2.close();
  await sleep(300);

  const ws3 = await connect();
  ws3.send(JSON.stringify({ type: 'login', username, password: 'pass123456', remember: false }));
  const login3 = await waitMsg(ws3, 'login_result');
  await waitMsg(ws3, 'name_set');
  ws3.send(JSON.stringify({ type: 'joined_rooms' }));
  const jr3 = await waitMsg(ws3, 'joined_rooms');
  const inList3 = jr3 && jr3.data && jr3.data.some(r => r.id === roomId);
  log(!inList3, '离开后重登不再恢复该房间',
    jr3 ? jr3.data.map(r => r.id).join(',') : '无响应');

  // 清理:删除测试房间和用户
  if (inList3) {
    ws3.send(JSON.stringify({ type: 'join_room', room_id: roomId, password: '' }));
    await waitMsg(ws3, 'room_joined');
    ws3.send(JSON.stringify({ type: 'delete_room', room_id: roomId }));
    await waitMsg(ws3, 'room_deleted');
  } else {
    const c2 = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'root', password: '299427', database: 'chat_db' });
    await c2.query('DELETE FROM rooms WHERE id=?', [roomId]);
    await c2.end();
  }
  ws3.close();

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('异常:', e.message); process.exit(1); });
