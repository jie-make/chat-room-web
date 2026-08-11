// 顶号(单点登录)验证: 新连接顶掉旧连接 + 作废旧 session 防抢登
const WebSocket = require('ws');
const URL = 'ws://localhost:3000';
let passed = 0, failed = 0;
const ts = Date.now();
function ok(m){passed++;console.log('  ✅ ' + m);}
function fail(m){failed++;console.log('  ❌ ' + m);}
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

async function test() {
  console.log('========== 顶号(单点登录)验证 ==========\n');

  console.log('[case 1] A 在线, B 换设备登录同账号: B 顶掉 A 直接成功');
  const A = await newWs(), B = await newWs();
  const uname = 'kick' + ts;
  send(A, { type: 'register', username: uname, nickname: 'kN' + ts, password: 'pass123456', remember: true });
  const rr = await waitType(A, 'register_result', 4000);
  if (rr && rr.ok && await waitType(A, 'name_set', 4000)) ok('A 已进入, token=' + (rr.token || '').slice(0, 8) + '...');
  else { fail('A 注册失败'); process.exit(1); }
  send(B, { type: 'login', username: uname, password: 'pass123456', remember: true });
  const lrB = await waitType(B, 'login_result', 4000);
  if (lrB && lrB.ok && await waitType(B, 'name_set', 4000)) ok('B 顶号成功,一次登录即进入');
  else { fail('B 登录失败: ' + JSON.stringify(lrB)); process.exit(1); }
  const foA = await waitType(A, 'force_logout', 4000);
  if (foA && foA.reason.indexOf('其他设备') >= 0) ok('A 被顶下线: ' + foA.reason);
  else fail('A 未被顶下线: ' + JSON.stringify(foA));

  console.log('[case 2] A 用旧 token 刷新重连: 应被拒(session 已作废,防止循环抢登)');
  const A2 = await newWs();
  send(A2, { type: 'login', token: rr.token });
  const lrA2 = await waitType(A2, 'login_result', 4000);
  if (lrA2 && !lrA2.ok && lrA2.error.indexOf('过期') >= 0) ok('旧 token 已被作废: ' + lrA2.error);
  else fail('旧 token 仍可用: ' + JSON.stringify(lrA2));
  A2.close();
  await sleep(400);

  console.log('[case 3] 新设备 B 刷新(token 自动登录): 仍在线,直接成功');
  const B2 = await newWs();
  send(B2, { type: 'login', token: lrB.token });
  const lrB2 = await waitType(B2, 'login_result', 4000);
  if (lrB2 && lrB2.ok && await waitType(B2, 'name_set', 4000)) ok('B 刷新后 token 登录成功');
  else fail('B 刷新后失败: ' + JSON.stringify(lrB2));
  A.close(); B.close(); B2.close();
  await sleep(400);

  console.log('[case 4] 同名临时用户被注册用户顶掉');
  const G = await newWs(), U = await newWs();
  send(G, { type: 'set_name', name: 'gK' + ts });
  if (await waitType(G, 'name_set')) ok('临时用户已进入');
  send(U, { type: 'register', username: 'u' + ts, nickname: 'gK' + ts, password: 'pass123456', remember: true });
  const ur = await waitType(U, 'register_result', 4000);
  if (ur && ur.ok) {
    const foG = await waitType(G, 'force_logout', 4000);
    if (foG) ok('临时用户被顶: ' + foG.reason);
    else fail('临时用户未被顶');
  } else { fail('注册失败: ' + JSON.stringify(ur)); }
  G.close(); U.close();
  await sleep(400);

  console.log('[case 5] jie 顶号正常(回归)');
  const J1 = await newWs(), J2 = await newWs();
  send(J1, { type: 'set_name', name: 'jie', password: '299427' });
  await waitType(J1, 'name_set');
  send(J2, { type: 'set_name', name: 'jie', password: '299427' });
  if (await waitType(J2, 'name_set', 4000)) ok('J2 顶号成功');
  else fail('J2 顶号失败');
  J1.close(); J2.close();

  console.log('\n========== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ==========');
  process.exit(failed ? 1 : 0);
}
test();
