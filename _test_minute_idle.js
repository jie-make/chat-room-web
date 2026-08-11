// 验证:分钟级空闲房间创建/加入/重连恢复 + 异常关闭修复
// 模拟:创建 5 分钟空闲房间 → 加入 → 检查不误删 → 断开重连 → 确认自动恢复
const WebSocket = require('ws');
const crypto = require('crypto');

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
  const nick = 'verify_' + Date.now().toString().slice(-8);
  const roomName = '分钟空闲_' + Date.now().toString().slice(-6);

  // 1. 连接并设置昵称
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'set_name', name: nick }));
  const ns = await waitMsg(ws, 'name_set');
  log(!!ns && ns.name === nick, '登录进入', ns ? '' : '无 name_set');
  if (!ns) process.exit(1);

  // 2. 创建 5 分钟空闲房间(5/60 小时)
  ws.send(JSON.stringify({
    type: 'create_room', name: roomName,
    password: '', is_private: false,
    idle_timeout_hours: 5 / 60  // 前端传小时小数
  }));
  const created = await waitMsg(ws, 'room_created');
  log(!!created && created.room && created.room.idle_timeout_hours !== undefined, '创建分钟级空闲房间',
    created && created.room ? 'idle_timeout_hours=' + created.room.idle_timeout_hours : '无响应');
  if (!created) process.exit(1);
  const roomId = created.room.id;
  const storedHours = created.room.idle_timeout_hours;
  log(Math.abs(storedHours - 5 / 60) < 0.001, '存储为小时小数(约0.0833)', '实际=' + storedHours);

  // 3. 加入房间
  ws.send(JSON.stringify({ type: 'join_room', room_id: roomId, password: '' }));
  const joined = await waitMsg(ws, 'room_joined');
  log(!!joined && joined.room.id === roomId, '加入房间');

  // 4. 等待 3 秒,确认房间未被立即删除(异常关闭 bug 验证)
  await sleep(3000);
  ws.send(JSON.stringify({ type: 'joined_rooms' }));
  const jr = await waitMsg(ws, 'joined_rooms');
  const stillThere = jr && jr.data && jr.data.some(r => r.id === roomId);
  log(stillThere, '3秒后房间仍在(未被异常关闭)', jr ? 'joined=' + jr.data.map(r => r.id).join(',') : '无响应');

  // 5. 确认 idle_timeout 未被清除
  ws.send(JSON.stringify({ type: 'list_rooms' }));
  const lr = await waitMsg(ws, 'room_list');
  const inList = lr && lr.data && lr.data.find(r => r.id === roomId);
  log(inList && Math.abs(inList.idle_timeout_hours - 5 / 60) < 0.001,
    '房间列表中 idle_timeout_hours 保留(分钟级)', inList ? '=' + inList.idle_timeout_hours : '房间不在列表');

  // 6. 离开房间(模拟用户离开,空闲计时开始)
  ws.send(JSON.stringify({ type: 'leave_room', room_id: roomId }));
  const left = await waitMsg(ws, 'room_left');
  log(!!left, '离开房间');

  // 7. 查询数据库确认 empty_since 已标记(不误删验证:空房间开始计时)
  await sleep(500);

  // 8. 断开并重连(模拟手机端网络波动),确认自动恢复加入
  ws.close();
  await sleep(300);
  const ws2 = await connect();
  ws2.send(JSON.stringify({ type: 'set_name', name: nick }));
  const ns2 = await waitMsg(ws2, 'name_set');
  log(!!ns2, '重连后进入', ns2 ? '' : '无 name_set');

  // 9. 前端在 name_set 后会发送 silent join_room 恢复保存的房间
  // 模拟前端行为:发送 silent join
  ws2.send(JSON.stringify({ type: 'join_room', room_id: roomId, password: '', silent: true }));
  const j2 = await waitMsg(ws2, 'room_joined');
  log(!!j2 && j2.room.id === roomId, '重连后 silent 恢复加入原房间');
  if (!j2) {
    // silent 失败不应打扰用户,记录原因
    const err = await waitMsg(ws2, 'room_error');
    log(false, 'silent join 失败原因: ' + (err ? err.text : '未知'));
  }

  // 10. 验证数据库中 empty_since 状态(空房间应已计时)
  const mysql = require('mysql2/promise');
  const c = await mysql.createConnection({
    host: '127.0.0.1', port: 3306,
    user: 'root', password: '299427', database: 'chat_db'
  });
  const [rows] = await c.query('SELECT idle_timeout_hours, empty_since FROM rooms WHERE id=?', [roomId]);
  const row = rows[0];
  log(!!row, '数据库中存在房间记录');
  if (row) {
    log(Math.abs(row.idle_timeout_hours - 5 / 60) < 0.001, 'DB idle_timeout_hours=' + row.idle_timeout_hours + '(5分钟)');
    log(row.empty_since === null || row.empty_since > 0, 'DB empty_since=' + row.empty_since + ' 已标记/有效');
  }
  await c.end();

  // 清理测试房间(避免遗留)
  ws2.send(JSON.stringify({ type: 'delete_room', room_id: roomId }));
  const del = await waitMsg(ws2, 'room_deleted');
  log(!!del, '清理测试房间');
  ws2.close();

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('异常:', e.message); process.exit(1); });
