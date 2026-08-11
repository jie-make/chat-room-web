// 复现: 创建带 1 小时空闲超时的房间, 观察是否被异常标记过期
const WebSocket = require('ws');
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
  const jie = await newWs();
  send(jie, { type: 'login', username: 'jie', password: '299427', remember: true });
  await waitType(jie, 'login_result');

  console.log('创建带 1 小时空闲超时的公开房间');
  send(jie, { type: 'create_room', name: 'idle测试' + ts, password: '', is_private: false, idle_timeout_hours: 1 });
  const rc = await waitType(jie, 'room_created', 4000);
  if (!rc || !rc.room) { console.log('创建失败:', JSON.stringify(rc)); process.exit(1); }
  const room = rc.room;
  console.log('创建成功:', JSON.stringify({ id: room.id, idle_timeout_hours: room.idle_timeout_hours }));

  console.log('房主加入房间');
  send(jie, { type: 'join_room', room_id: room.id, password: '' });
  const rj = await waitType(jie, 'room_joined', 4000);
  if (rj) console.log('加入成功, idle_timeout_hours=', rj.room.idle_timeout_hours, 'empty_since=', rj.room.empty_since);
  else console.log('加入失败/超时');

  console.log('等待 3 秒(扫描间隔为 5 分钟, 正常不会触发清理)');
  await sleep(3000);
  send(jie, { type: 'list_rooms' });
  const rl = await waitType(jie, 'room_list', 4000);
  const myRoom = (rl.data || []).find(r => r.id === room.id);
  if (myRoom) console.log('房间仍在列表:', myRoom.name, '| idle_h=', myRoom.idle_timeout_hours, '| empty_since=', myRoom.empty_since, '| online=', myRoom.online);
  else console.log('❌ 房间已从列表消失!');

  jie.close();
  process.exit(0);
})();
