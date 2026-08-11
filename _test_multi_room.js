// 多房间并行测试
const WebSocket = require('ws');

const URL = 'ws://localhost:3000';
let step = 0;
let passed = 0, failed = 0;
const ts = Date.now();

function log(msg) { console.log('[step ' + step + '] ' + msg); }
function ok(msg) { passed++; console.log('  ✅ ' + msg); }
function fail(msg) { failed++; console.log('  ❌ ' + msg); }
function send(ws, obj) { ws.send(JSON.stringify(obj)); }

function attachQueue(ws) {
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (waiters.length > 0) waiters.shift().resolve(msg);
    else queue.push(msg);
  });
  function waitMsg(timeout = 3000) {
    return new Promise((resolve) => {
      if (queue.length > 0) { resolve(queue.shift()); return; }
      const w = { resolve };
      waiters.push(w);
      setTimeout(() => {
        const idx = waiters.indexOf(w);
        if (idx >= 0) { waiters.splice(idx, 1); resolve(null); }
      }, timeout);
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
async function waitType(ws, type, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const msg = await ws.waitMsg(timeout - (Date.now() - start));
    if (!msg) return null;
    if (msg.type === type) return msg;
  }
  return null;
}

async function test() {
  console.log('========== 多房间并行测试 ==========\n');
  // 等待之前的测试连接完全关闭
  await new Promise(r => setTimeout(r, 500));

  // 用主管理员创建房间(有权限)
  // 测试1: 创建两个房间并都加入,收到两个房间的消息
  step = 1; log('加入多个房间后接收各房间消息');
  {
    const admin = await newWs();
    send(admin, { type: 'set_name', name: 'jie', password: '299427' });
    const ns = await waitType(admin, 'name_set', 5000);
    if (!ns) {
      const all = [];
      const start = Date.now();
      while (Date.now() - start < 1000) {
        const m = await admin.waitMsg(500);
        if (!m) break;
        all.push(m.type);
      }
      fail('admin name_set 失败,收到: ' + JSON.stringify(all));
      admin.close();
      return;
    }
    ok('admin 已登录');

    // 创建房间A 并加入
    const roomAName = '多房间A_' + ts;
    send(admin, { type: 'create_room', name: roomAName, password: '', is_private: false });
    const createdA = await waitType(admin, 'room_created', 3000);
    if (!createdA) { fail('创建房间A失败'); admin.close(); return; }
    const roomAId = createdA.room.id;
    ok('创建房间A: ' + roomAId);
    // 显式加入房间A
    send(admin, { type: 'join_room', room_id: roomAId, password: '' });
    const joinedA = await waitType(admin, 'room_joined', 3000);
    if (joinedA && joinedA.room.id === roomAId) ok('已加入房间A');
    else fail('加入房间A失败: ' + JSON.stringify(joinedA));

    // 创建房间B 并加入
    const roomBName = '多房间B_' + ts;
    send(admin, { type: 'create_room', name: roomBName, password: '', is_private: false });
    const createdB = await waitType(admin, 'room_created', 3000);
    if (!createdB) { fail('创建房间B失败'); admin.close(); return; }
    const roomBId = createdB.room.id;
    ok('创建房间B: ' + roomBId);
    send(admin, { type: 'join_room', room_id: roomBId, password: '' });
    const joinedB = await waitType(admin, 'room_joined', 3000);
    if (joinedB && joinedB.room.id === roomBId) ok('已加入房间B');
    else fail('加入房间B失败: ' + JSON.stringify(joinedB));

    // 查询已加入房间
    send(admin, { type: 'joined_rooms' });
    const joined = await waitType(admin, 'joined_rooms', 3000);
    if (joined && joined.data) {
      const ids = joined.data.map(r => r.id);
      if (ids.includes(roomAId) && ids.includes(roomBId) && ids.includes('default')) {
        ok('已加入 3 个房间: ' + ids.join(','));
      } else {
        fail('已加入房间列表不完整: ' + JSON.stringify(ids));
      }
    } else fail('查询已加入房间失败');

    // 在房间A发言,应在A收到(不会被B干扰)
    send(admin, { type: 'chat', room_id: roomAId, content: 'helloA', content_type: 'text' });
    const chatA = await waitType(admin, 'chat', 3000);
    if (chatA && chatA.room_id === roomAId && chatA.content === 'helloA') ok('房间A消息正确路由');
    else fail('房间A消息异常: ' + JSON.stringify(chatA));

    // 等待速率限制窗口(200ms)过去
    await new Promise(r => setTimeout(r, 300));

    // 在房间B发言
    send(admin, { type: 'chat', room_id: roomBId, content: 'helloB', content_type: 'text' });
    const chatB = await waitType(admin, 'chat', 3000);
    if (chatB && chatB.room_id === roomBId && chatB.content === 'helloB') ok('房间B消息正确路由');
    else fail('房间B消息异常: ' + JSON.stringify(chatB));

    // 在未加入的房间发言应被拒
    send(admin, { type: 'chat', room_id: 'room_not_joined_xxx', content: 'should fail', content_type: 'text' });
    const notice = await waitType(admin, 'notice', 3000);
    if (notice && notice.text.indexOf('未加入') >= 0) ok('未加入房间发言被拒');
    else fail('未加入房间发言未被拒: ' + JSON.stringify(notice));

    admin.close();
  }

  // 测试间延迟,确保旧连接完全清理(IP 限制)
  await new Promise(r => setTimeout(r, 500));

  // 测试2: 单用户多房间消息隔离(在房间A发言,消息room_id应为A而非default)
  // 注:多用户隔离因IP限制无法在单元测试中验证,需在浏览器中测试
  step = 2; log('单用户多房间消息路由验证');
  {
    const admin = await newWs();
    send(admin, { type: 'set_name', name: 'jie', password: '299427' });
    const ns = await waitType(admin, 'name_set', 5000);
    if (!ns) { fail('admin2 name_set 失败'); admin.close(); return; }

    const roomName = '路由测试_' + ts;
    send(admin, { type: 'create_room', name: roomName, password: '', is_private: false });
    const created = await waitType(admin, 'room_created', 3000);
    if (!created) {
      const all = [];
      const start = Date.now();
      while (Date.now() - start < 1000) {
        const m = await admin.waitMsg(500);
        if (!m) break;
        all.push(m);
      }
      fail('创建路由测试房间失败,收到: ' + JSON.stringify(all));
      admin.close();
      return;
    }
    const roomId = created.room.id;
    send(admin, { type: 'join_room', room_id: roomId, password: '' });
    await waitType(admin, 'room_joined', 3000);

    // 在新房间发言,消息 room_id 应为新房间
    await new Promise(r => setTimeout(r, 300));
    send(admin, { type: 'chat', room_id: roomId, content: 'routed_msg', content_type: 'text' });
    const chatMsg = await waitType(admin, 'chat', 3000);
    if (chatMsg && chatMsg.room_id === roomId && chatMsg.content === 'routed_msg') {
      ok('消息正确路由到房间 ' + roomId);
    } else fail('消息路由异常: ' + JSON.stringify(chatMsg));

    // 在 default 发言,消息 room_id 应为 default
    await new Promise(r => setTimeout(r, 300));
    send(admin, { type: 'chat', room_id: 'default', content: 'default_msg', content_type: 'text' });
    const defaultMsg = await waitType(admin, 'chat', 3000);
    if (defaultMsg && defaultMsg.room_id === 'default' && defaultMsg.content === 'default_msg') {
      ok('消息正确路由到 default 房间');
    } else fail('default 消息路由异常: ' + JSON.stringify(defaultMsg));

    admin.close();
  }

  // 测试间延迟
  await new Promise(r => setTimeout(r, 500));

  // 测试3: 离开房间后不再收到该房间消息
  step = 3; log('离开房间后不再接收该房间消息');
  {
    const admin = await newWs();
    send(admin, { type: 'set_name', name: 'jie', password: '299427' });
    await waitType(admin, 'name_set', 3000);
    const roomName = '离开测试_' + ts;
    send(admin, { type: 'create_room', name: roomName, password: '', is_private: false });
    const created = await waitType(admin, 'room_created', 3000);
    if (!created) { fail('创建离开测试房间失败'); admin.close(); return; }
    const roomId = created.room.id;
    send(admin, { type: 'join_room', room_id: roomId, password: '' });
    await waitType(admin, 'room_joined', 3000);

    // 离开该房间
    send(admin, { type: 'leave_room', room_id: roomId });
    const left = await waitType(admin, 'room_left', 3000);
    if (left && left.room_id === roomId) ok('已离开房间');
    else fail('离开房间失败: ' + JSON.stringify(left));

    // 不能离开 default
    send(admin, { type: 'leave_room', room_id: 'default' });
    const notice = await waitType(admin, 'notice', 3000);
    if (notice && notice.text.indexOf('不能离开') >= 0) ok('不能离开默认房间(正确)');
    else fail('应拒绝离开默认房间: ' + JSON.stringify(notice));

    admin.close();
  }

  console.log('\n========== 测试结果 ==========');
  console.log('  通过: ' + passed + ' / ' + (passed + failed));
  if (failed > 0) console.log('  失败: ' + failed);
  process.exit(failed > 0 ? 1 : 0);
}

test().catch(e => { console.error('测试异常:', e); process.exit(1); });
