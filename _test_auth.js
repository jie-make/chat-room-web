// 账号系统端到端测试
const WebSocket = require('ws');

const URL = 'ws://localhost:3000';
let step = 0;
let passed = 0, failed = 0;
const ts = Date.now(); // 本次测试唯一标识,避免昵称冲突

function log(msg) { console.log('[step ' + step + '] ' + msg); }
function ok(msg) { passed++; console.log('  ✅ ' + msg); }
function fail(msg) { failed++; console.log('  ❌ ' + msg); }
function send(ws, obj) { ws.send(JSON.stringify(obj)); }

function waitMsg(ws, timeout = 3000) {
  return new Promise((resolve) => {
    let timer = setTimeout(() => resolve(null), timeout);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(raw.toString())); } catch (e) { resolve(null); }
    });
  });
}

async function waitType(ws, type, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const msg = await waitMsg(ws, timeout - (Date.now() - start));
    if (!msg) return null;
    if (msg.type === type) return msg;
  }
  return null;
}

async function test() {
  console.log('========== 账号系统测试 ==========\n');

  // 测试1: 注册新用户
  step = 1; log('注册新用户');
  {
    const ws = new WebSocket(URL);
    await new Promise(r => ws.on('open', r));
    send(ws, { type: 'register', username: 'tu' + ts, nickname: '测试用户' + ts, password: '123456', remember: true });
    const msg = await waitType(ws, 'register_result', 3000);
    if (msg && msg.ok) {
      ok('注册成功,收到 token: ' + (msg.token ? '是' : '否'));
      const nameSet = await waitType(ws, 'name_set', 3000);
      if (nameSet && nameSet.is_registered) ok('收到 name_set, is_registered=true');
      else fail('未收到 name_set 或 is_registered 错误: ' + JSON.stringify(nameSet));
    } else fail('注册失败: ' + (msg && msg.error));
    ws.close();
  }

  // 测试2: 重复用户名注册
  step = 2; log('重复用户名注册');
  {
    const ws = new WebSocket(URL);
    await new Promise(r => ws.on('open', r));
    const uname = 'dup' + ts;
    send(ws, { type: 'register', username: uname, nickname: '昵称A' + ts, password: '123456' });
    await waitType(ws, 'register_result', 3000);
    send(ws, { type: 'register', username: uname, nickname: '昵称B' + ts, password: '123456' });
    const msg = await waitType(ws, 'register_result', 3000);
    if (msg && !msg.ok && msg.error.indexOf('用户名') >= 0) ok('正确拒绝重复用户名: ' + msg.error);
    else fail('未正确拒绝重复用户名: ' + JSON.stringify(msg));
    ws.close();
  }

  // 测试3: 重复昵称注册
  step = 3; log('重复昵称注册');
  {
    const ws = new WebSocket(URL);
    await new Promise(r => ws.on('open', r));
    const nick = '同昵称' + ts;
    send(ws, { type: 'register', username: 'u1' + ts, nickname: nick, password: '123456' });
    await waitType(ws, 'register_result', 3000);
    send(ws, { type: 'register', username: 'u2' + ts, nickname: nick, password: '123456' });
    const msg = await waitType(ws, 'register_result', 3000);
    if (msg && !msg.ok && msg.error.indexOf('昵称') >= 0) ok('正确拒绝重复昵称: ' + msg.error);
    else fail('未正确拒绝重复昵称: ' + JSON.stringify(msg));
    ws.close();
  }

  // 测试4: 密码登录
  step = 4; log('密码登录');
  let savedToken = null;
  {
    const ws = new WebSocket(URL);
    await new Promise(r => ws.on('open', r));
    const uname = 'login' + ts;
    send(ws, { type: 'register', username: uname, nickname: '登录测试' + ts, password: 'abc123' });
    await waitType(ws, 'register_result', 3000);
    await waitType(ws, 'name_set', 3000);
    ws.close();

    await new Promise(r => setTimeout(r, 200)); // 等待连接关闭
    const ws2 = new WebSocket(URL);
    await new Promise(r => ws2.on('open', r));
    send(ws2, { type: 'login', username: uname, password: 'abc123', remember: true });
    const loginMsg = await waitType(ws2, 'login_result', 3000);
    if (loginMsg && loginMsg.ok) {
      savedToken = loginMsg.token;
      ok('密码登录成功,收到 token: ' + (savedToken ? '是' : '否'));
      const nameSet = await waitType(ws2, 'name_set', 3000);
      if (nameSet && nameSet.is_registered) ok('登录后收到 name_set, is_registered=true');
      else fail('未收到 name_set: ' + JSON.stringify(nameSet));
    } else fail('密码登录失败: ' + (loginMsg && loginMsg.error));
    ws2.close();
  }

  // 测试5: Token 自动登录
  step = 5; log('Token 自动登录');
  if (savedToken) {
    const ws = new WebSocket(URL);
    await new Promise(r => ws.on('open', r));
    send(ws, { type: 'login', token: savedToken });
    const nameSet = await waitType(ws, 'name_set', 3000);
    if (nameSet && nameSet.is_registered) ok('token 自动登录成功, is_registered=true');
    else fail('token 自动登录失败: ' + JSON.stringify(nameSet));
    ws.close();
  } else fail('跳过(无 savedToken)');

  // 测试6: 错误密码登录
  step = 6; log('错误密码登录');
  {
    const ws = new WebSocket(URL);
    await new Promise(r => ws.on('open', r));
    const uname = 'wrongpwd' + ts;
    send(ws, { type: 'register', username: uname, nickname: '错密测试' + ts, password: 'correct' });
    await waitType(ws, 'register_result', 3000);
    await waitType(ws, 'name_set', 3000);
    ws.close();

    await new Promise(r => setTimeout(r, 200));
    const ws2 = new WebSocket(URL);
    await new Promise(r => ws2.on('open', r));
    send(ws2, { type: 'login', username: uname, password: 'wrongpassword' });
    const msg = await waitType(ws2, 'login_result', 3000);
    if (msg && !msg.ok && msg.error.indexOf('密码') >= 0) ok('正确拒绝错误密码: ' + msg.error);
    else fail('未正确拒绝错误密码: ' + JSON.stringify(msg));
    ws2.close();
  }

  // 测试7: 临时用户不能用已注册昵称
  step = 7; log('临时用户使用已注册昵称');
  {
    const ws = new WebSocket(URL);
    await new Promise(r => ws.on('open', r));
    const nick = '占用昵称' + ts;
    send(ws, { type: 'register', username: 'owner' + ts, nickname: nick, password: '123456' });
    await waitType(ws, 'register_result', 3000);
    await waitType(ws, 'name_set', 3000);
    ws.close();

    await new Promise(r => setTimeout(r, 200));
    const ws2 = new WebSocket(URL);
    await new Promise(r => ws2.on('open', r));
    send(ws2, { type: 'set_name', name: nick });
    const msg = await waitType(ws2, 'name_error', 3000);
    if (msg && msg.text.indexOf('已注册') >= 0) ok('正确拒绝临时用户使用已注册昵称: ' + msg.text);
    else fail('未正确拒绝: ' + JSON.stringify(msg));
    ws2.close();
  }

  // 测试8: 主管理员登录
  step = 8; log('主管理员登录');
  {
    const ws = new WebSocket(URL);
    await new Promise(r => ws.on('open', r));
    send(ws, { type: 'set_name', name: 'jie', password: '299427' });
    // 同时等待 name_set 或 name_error
    const start = Date.now();
    let result = null;
    while (Date.now() - start < 3000) {
      const msg = await waitMsg(ws, 3000 - (Date.now() - start));
      if (!msg) break;
      if (msg.type === 'name_set' || msg.type === 'name_error') { result = msg; break; }
    }
    if (result && result.type === 'name_set' && result.is_admin && result.is_super_admin) ok('主管理员登录成功, is_super_admin=true');
    else fail('主管理员登录失败: ' + JSON.stringify(result));
    ws.close();
  }

  // 测试9: 主管理员昵称保护
  step = 9; log('主管理员昵称保护');
  {
    const ws = new WebSocket(URL);
    await new Promise(r => ws.on('open', r));
    send(ws, { type: 'set_name', name: 'jie' });
    const msg = await waitType(ws, 'name_error', 3000);
    if (msg && msg.text.indexOf('保留') >= 0) ok('正确保护主管理员昵称: ' + msg.text);
    else fail('未正确保护: ' + JSON.stringify(msg));
    ws.close();
  }

  // 测试10: 登出
  step = 10; log('登出');
  {
    const ws = new WebSocket(URL);
    await new Promise(r => ws.on('open', r));
    const uname = 'logout' + ts;
    send(ws, { type: 'register', username: uname, nickname: '登出测试' + ts, password: '123456' });
    await waitType(ws, 'register_result', 3000);
    await waitType(ws, 'name_set', 3000);
    // 等待一小段时间确保 userInfo 在服务端已设置
    await new Promise(r => setTimeout(r, 300));
    send(ws, { type: 'logout' });
    // 收集所有消息,找到 logged_out
    const start = Date.now();
    let found = null;
    const received = [];
    while (Date.now() - start < 3000) {
      const msg = await waitMsg(ws, 3000 - (Date.now() - start));
      if (!msg) break;
      received.push(msg.type);
      if (msg.type === 'logged_out') { found = msg; break; }
    }
    if (found) ok('登出成功,收到 logged_out');
    else fail('登出失败,收到的消息类型: ' + JSON.stringify(received));
    ws.close();
  }

  console.log('\n========== 测试结果 ==========');
  console.log('  通过: ' + passed + ' / ' + (passed + failed));
  if (failed > 0) console.log('  失败: ' + failed);
  process.exit(failed > 0 ? 1 : 0);
}

test().catch(e => { console.error('测试异常:', e); process.exit(1); });
