// 验证:群聊(房间)未读服务端持久化
// 场景:用户A在房间R中,用户B发消息 → A不在查看R → A刷新(重新登录) → 未读应恢复
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
  const userA = 'unreadA_' + t, nickA = '未读A_' + t;
  const userB = 'unreadB_' + t, nickB = '未读B_' + t;
  const roomName = '未读验证_' + t;
  let roomId = null;

  // 1. 注册 A、B 并创建房间
  const A = await connect();
  A.send(JSON.stringify({ type: 'register', username: userA, nickname: nickA, password: 'pass123456', remember: false }));
  const regA = await waitMsg(A, 'register_result');
  log(!!regA && regA.ok, '注册用户 A: ' + nickA);
  await waitMsg(A, 'name_set');
  // 请求 joined_rooms 模拟前端登录流程
  A.send(JSON.stringify({ type: 'joined_rooms' }));
  await waitMsg(A, 'joined_rooms');

  const B = await connect();
  B.send(JSON.stringify({ type: 'register', username: userB, nickname: nickB, password: 'pass123456', remember: false }));
  const regB = await waitMsg(B, 'register_result');
  log(!!regB && regB.ok, '注册用户 B: ' + nickB);
  await waitMsg(B, 'name_set');

  // 2. A 创建房间并加入
  A.send(JSON.stringify({ type: 'create_room', name: roomName, password: '', is_private: false, idle_timeout_hours: null }));
  const created = await waitMsg(A, 'room_created');
  roomId = created.room.id;
  log(!!roomId, 'A 创建房间: ' + roomName);
  // A 已自动加入(room_created 后前端发 join_room)
  A.send(JSON.stringify({ type: 'join_room', room_id: roomId, password: '' }));
  await waitMsg(A, 'room_joined');
  // B 加入房间
  B.send(JSON.stringify({ type: 'join_room', room_id: roomId, password: '' }));
  await waitMsg(B, 'room_joined');
  await sleep(300);

  // 3. A 切回 default 房间(模拟 A 不在查看该房间)
  A.send(JSON.stringify({ type: 'view_room_users', room_id: 'default' }));
  // 模拟前端: A 查看 default(发 mark_room_read default)
  A.send(JSON.stringify({ type: 'mark_room_read', room_id: 'default' }));
  await sleep(200);

  // 4. B 在房间 R 中发 2 条消息(A 不在查看 R,应产生未读)
  B.send(JSON.stringify({ type: 'chat', room_id: roomId, content: '第一条未读消息', content_type: 'text' }));
  await waitMsg(B, 'chat');
  await sleep(400); // 避免消息限流(200ms 间隔)
  B.send(JSON.stringify({ type: 'chat', room_id: roomId, content: '第二条未读消息', content_type: 'text' }));
  await waitMsg(B, 'chat');
  await sleep(400);

  // 5. A 离线重连(模拟刷新),重新登录
  A.send(JSON.stringify({ type: 'logout' }));
  await waitMsg(A, 'logged_out');
  A.close();
  await sleep(300);

  const A2 = await connect();
  A2.send(JSON.stringify({ type: 'login', username: userA, password: 'pass123456', remember: false }));
  const loginA2 = await waitMsg(A2, 'login_result');
  log(!!loginA2 && loginA2.ok, 'A 重新登录');
  await waitMsg(A2, 'name_set');

  // 6. A 请求 joined_rooms,应返回该房间未读=2
  A2.send(JSON.stringify({ type: 'joined_rooms' }));
  const jr = await waitMsg(A2, 'joined_rooms');
  const roomR = jr && jr.data && jr.data.find(r => r.id === roomId);
  log(!!roomR, 'joined_rooms 包含房间 R');
  // 调试: dump 数据库状态
  const mysql = require('mysql2/promise');
  const dbg = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'root', password: '299427', database: 'chat_db' });
  const [dbgMsgs] = await dbg.query("SELECT id, sender, content, time FROM messages WHERE scope='group' AND room_id=? ORDER BY time ASC", [roomId]);
  console.log('  [debug] 房间消息数:', dbgMsgs.length);
  dbgMsgs.forEach(m => console.log('    id=' + m.id, 'sender=' + m.sender, 'content=' + m.content, 'time=' + m.time));
  const [dbgRead] = await dbg.query('SELECT user_name, room_id, last_read_at FROM room_read_status WHERE room_id=?', [roomId]);
  console.log('  [debug] room_read_status:', JSON.stringify(dbgRead));
  await dbg.end();
  log(roomR && roomR.unread === 2, '房间 R 未读恢复为 2(刷新后持久化)', roomR ? 'unread=' + roomR.unread : '无房间');

  // 7. 前端收到 joined_rooms 后对持久化房间 silent join,保留未读
  A2.send(JSON.stringify({ type: 'join_room', room_id: roomId, password: '', silent: true }));
  const rj = await waitMsg(A2, 'room_joined');
  log(!!rj && rj.silent === true, 'silent join 恢复(保留未读)');

  // 8. 自己消息不误计: A2 切到 R 并标记已读,发一条自己的消息,未读不应+1
  A2.send(JSON.stringify({ type: 'mark_room_read', room_id: roomId }));
  A2.send(JSON.stringify({ type: 'chat', room_id: roomId, content: '自己的消息', content_type: 'text' }));
  await waitMsg(A2, 'chat');
  await sleep(300);
  A2.send(JSON.stringify({ type: 'joined_rooms' }));
  const jr2 = await waitMsg(A2, 'joined_rooms');
  const roomR2 = jr2 && jr2.data && jr2.data.find(r => r.id === roomId);
  log(roomR2 && roomR2.unread === 0, '标记已读+自己消息后未读=0', roomR2 ? 'unread=' + roomR2.unread : '无房间');

  // 清理
  A2.send(JSON.stringify({ type: 'delete_room', room_id: roomId }));
  await waitMsg(A2, 'room_deleted');
  A2.close(); B.close();

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('异常:', e.message); process.exit(1); });
