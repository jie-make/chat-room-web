// IP 单会话限制端到端测试
const WebSocket = require('ws');

const URL = 'ws://localhost:3000';
let step = 0;
let passed = 0, failed = 0;
const ts = Date.now();

function log(msg) { console.log('[step ' + step + '] ' + msg); }
function ok(msg) { passed++; console.log('  ✅ ' + msg); }
function fail(msg) { failed++; console.log('  ❌ ' + msg); }
function send(ws, obj) { ws.send(JSON.stringify(obj)); }
async function newWs() {
  const ws = new WebSocket(URL);
  await new Promise(r => ws.on('open', r));
  const { waitMsg } = attachQueue(ws);
  ws.waitMsg = waitMsg;
  return ws;
}

// 每个 ws 维护一个消息队列,持续监听避免消息丢失
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

async function waitType(ws, type, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const msg = await ws.waitMsg(timeout - (Date.now() - start));
    if (!msg) return null;
    if (msg.type === type) return msg;
  }
  return null;
}

// 等待任一指定类型消息
async function waitAnyTypes(ws, types, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const msg = await ws.waitMsg(timeout - (Date.now() - start));
    if (!msg) return null;
    if (types.includes(msg.type)) return msg;
  }
  return null;
}

async function test() {
  console.log('========== IP 单会话限制测试 ==========\n');

  // 测试1: 同 IP 第二个临时用户进入,第一个应被踢
  step = 1; log('同 IP 第二个临时用户踢掉第一个');
  {
    const ws1 = await newWs();
    send(ws1, { type: 'set_name', name: 'first_' + ts });
    const ns1 = await waitType(ws1, 'name_set', 3000);
    if (!ns1) { fail('第一个用户进入失败'); ws1.close(); return; }

    const ws2 = await newWs();
    send(ws2, { type: 'set_name', name: 'second_' + ts });
    const ns2 = await waitType(ws2, 'name_set', 3000);
    if (ns2) ok('第二个用户进入成功');
    else fail('第二个用户进入失败');

    // ws1 应收到 force_logout(可能已缓存在队列中)
    const fk = await waitType(ws1, 'force_logout', 3000);
    if (fk) ok('第一个用户被踢,收到 force_logout: ' + (fk.reason || ''));
    else fail('第一个用户未被踢');

    ws1.close();
    ws2.close();
  }

  // 测试2: 同 IP 注册用户登录踢掉临时用户
  step = 2; log('同 IP 注册用户踢掉临时用户');
  {
    // 先注册一个账号
    const regWs = await newWs();
    const uname = 'iplimit_' + ts;
    const nick = 'IPLimit_' + ts;
    send(regWs, { type: 'register', username: uname, nickname: nick, password: '123456' });
    await waitType(regWs, 'register_result', 3000);
    await waitType(regWs, 'name_set', 3000);
    regWs.close();
    await new Promise(r => setTimeout(r, 300));

    // 临时用户先进入
    const ws1 = await newWs();
    send(ws1, { type: 'set_name', name: 'guest_' + ts });
    const ns1 = await waitType(ws1, 'name_set', 3000);
    if (!ns1) { fail('临时用户进入失败'); ws1.close(); return; }

    // 注册用户登录(同 IP)
    const ws2 = await newWs();
    send(ws2, { type: 'login', username: uname, password: '123456' });
    const lr = await waitType(ws2, 'login_result', 3000);
    if (lr && lr.ok) ok('注册用户登录成功');
    else fail('注册用户登录失败: ' + JSON.stringify(lr));

    // ws1 应收到 force_logout
    const fk = await waitType(ws1, 'force_logout', 3000);
    if (fk) ok('临时用户被注册用户踢掉: ' + (fk.reason || ''));
    else fail('临时用户未被踢');

    ws1.close();
    ws2.close();
  }

  // 测试3: 同 IP 临时用户登录踢掉已登录的注册用户
  step = 3; log('同 IP 临时用户踢掉已登录注册用户');
  {
    // 注册账号
    const regWs = await newWs();
    const uname = 'iplimit3_' + ts;
    const nick = 'IPLimit3_' + ts;
    send(regWs, { type: 'register', username: uname, nickname: nick, password: '123456' });
    await waitType(regWs, 'register_result', 3000);
    await waitType(regWs, 'name_set', 3000);
    regWs.close();
    await new Promise(r => setTimeout(r, 300));

    // 注册用户先登录
    const ws1 = await newWs();
    send(ws1, { type: 'login', username: uname, password: '123456' });
    await waitType(ws1, 'login_result', 3000);
    const ns1 = await waitType(ws1, 'name_set', 3000);
    if (!ns1) { fail('注册用户登录失败'); ws1.close(); return; }

    // 临时用户进入(同 IP)
    const ws2 = await newWs();
    send(ws2, { type: 'set_name', name: 'guest3_' + ts });
    const ns2 = await waitType(ws2, 'name_set', 3000);
    if (ns2) ok('临时用户进入成功');
    else fail('临时用户进入失败');

    // ws1 应收到 force_logout
    const fk = await waitType(ws1, 'force_logout', 3000);
    if (fk) ok('注册用户被临时用户踢掉: ' + (fk.reason || ''));
    else fail('注册用户未被踢');

    ws1.close();
    ws2.close();
  }

  // 测试4: 登出后再登录应正常(同 IP 但旧连接已关闭)
  step = 4; log('登出后同 IP 重新登录正常');
  {
    const ws1 = await newWs();
    send(ws1, { type: 'set_name', name: 'reuse_' + ts });
    await waitType(ws1, 'name_set', 3000);
    send(ws1, { type: 'logout' });
    await waitType(ws1, 'logged_out', 3000);
    ws1.close();
    await new Promise(r => setTimeout(r, 300));

    const ws2 = await newWs();
    send(ws2, { type: 'set_name', name: 'reuse2_' + ts });
    const ns = await waitType(ws2, 'name_set', 3000);
    if (ns) ok('登出后同 IP 重新进入成功');
    else fail('登出后同 IP 重新进入失败');

    ws2.close();
  }

  console.log('\n========== 测试结果 ==========');
  console.log('  通过: ' + passed + ' / ' + (passed + failed));
  if (failed > 0) console.log('  失败: ' + failed);
  process.exit(failed > 0 ? 1 : 0);
}

test().catch(e => { console.error('测试异常:', e); process.exit(1); });
