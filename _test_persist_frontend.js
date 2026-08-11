// 验证:浏览器完整流程(模拟前端) - 注册用户加入房间→登出→重新登录→前端自动恢复
// 重点:重登后前端在 name_set 后请求 joined_rooms,收到后自动 silent join 恢复
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

// 模拟前端连接+登录流程(返回 name_set 消息)
async function frontendLogin(username, password, token) {
  const ws = await connect();
  if (token) ws.send(JSON.stringify({ type: 'login', token }));
  else ws.send(JSON.stringify({ type: 'login', username, password, remember: false }));
  const lr = await waitMsg(ws, 'login_result');
  if (!lr || !lr.ok) { ws.close(); return { ws: null, error: lr && lr.error }; }
  await waitMsg(ws, 'name_set');
  return { ws, token: lr.token };
}

(async () => {
  const t = Date.now().toString().slice(-8);
  const username = 'fl_' + t;
  const nickname = '前端流程_' + t;
  const roomName = '恢复验证_' + t;

  // 1. 注册并进入
  const ws0 = await connect();
  ws0.send(JSON.stringify({ type: 'register', username, nickname, password: 'pass123456', remember: true }));
  const reg = await waitMsg(ws0, 'register_result');
  log(!!reg && reg.ok, '注册用户');
  if (!reg || !reg.ok) { console.log('  失败:', reg && reg.error); process.exit(1); }
  const token = reg.token;
  await waitMsg(ws0, 'name_set');

  // 2. 创建并加入房间
  ws0.send(JSON.stringify({ type: 'create_room', name: roomName, password: '', is_private: false, idle_timeout_hours: null }));
  const created = await waitMsg(ws0, 'room_created');
  const roomId = created.room.id;
  ws0.send(JSON.stringify({ type: 'join_room', room_id: roomId, password: '' }));
  const joined = await waitMsg(ws0, 'room_joined');
  log(!!joined, '创建并加入房间');
  await sleep(300);
  // 前端本地保存
  // (模拟 localStorage saveJoinedRoom)
  ws0.send(JSON.stringify({ type: 'logout' }));
  await waitMsg(ws0, 'logged_out');
  ws0.close();
  await sleep(300);

  // 3. 重新登录(新连接,模拟浏览器刷新后 token 自动登录 或 重新输账号密码)
  const { ws: ws1, token: token1 } = await frontendLogin(username, 'pass123456');
  log(!!ws1, '重新登录成功');
  if (!ws1) process.exit(1);

  // 4. 前端在 name_set 后自动请求 joined_rooms(模拟 index.html 行为)
  ws1.send(JSON.stringify({ type: 'joined_rooms' }));
  const jr = await waitMsg(ws1, 'joined_rooms');
  const roomInList = jr && jr.data && jr.data.some(r => r.id === roomId);
  log(!!roomInList, 'joined_rooms 返回持久化房间',
    jr ? jr.data.map(r => r.id).join(',') : '无响应');

  // 5. 前端对列表中的新房间发送 silent join(模拟 index.html joined_rooms 处理)
  if (roomInList) {
    ws1.send(JSON.stringify({ type: 'join_room', room_id: roomId, password: '', silent: true }));
    const j2 = await waitMsg(ws1, 'room_joined');
    log(!!j2 && j2.room.id === roomId, '前端 silent join 恢复(侧边栏出现该房间)');

    // 6. 在恢复的房间中发消息应成功
    ws1.send(JSON.stringify({ type: 'chat', room_id: roomId, content: '恢复后测试消息', content_type: 'text' }));
    const chat = await waitMsg(ws1, 'chat');
    log(!!chat && chat.room_id === roomId, '恢复的房间可正常发消息');

    // 7. 清理
    ws1.send(JSON.stringify({ type: 'delete_room', room_id: roomId }));
    await waitMsg(ws1, 'room_deleted');
  } else {
    log(false, '前端恢复流程(房间不在列表,跳过)');
  }
  ws1.close();
  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('异常:', e.message); process.exit(1); });
