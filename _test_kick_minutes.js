// 验证:管理后台强制下线分钟输入(0=永久,上限10080=7天)
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
    const timer = setTimeout(() => { ws.off('message', onMsg); resolve(null); }, timeout || 6000);
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
  const victim = 'kick分钟_' + t;

  // 管理员登录
  const admin = await connect();
  admin.send(JSON.stringify({ type: 'login', username: 'jie', password: '299427' }));
  const li = await waitMsg(admin, 'login_result');
  log(!!li && li.ok, '主管理员 jie 登录');
  if (!li || !li.ok) process.exit(1);

  // 受害者进入
  const v = await connect();
  v.send(JSON.stringify({ type: 'set_name', name: victim }));
  const ns = await waitMsg(v, 'name_set');
  log(!!ns && ns.name === victim, '受害者进入: ' + victim);

  // case1: 0 分钟 = 永久禁止
  admin.send(JSON.stringify({ type: 'admin_kick', name: victim, duration_minutes: 0 }));
  const kicked1 = await waitMsg(v, 'kicked');
  log(!!kicked1 && kicked1.duration_minutes === 0, '0分钟=永久下线', kicked1 ? 'duration=' + kicked1.duration_minutes : '未收到kicked');
  await sleep(300);

  // 受害者重进应被拒(永久禁令)
  const v2 = await connect();
  v2.send(JSON.stringify({ type: 'set_name', name: victim }));
  const kickedRe = await waitMsg(v2, 'kicked', 5000);
  log(!!kickedRe && kickedRe.reason.indexOf('永久') >= 0, '永久禁令:重进被拒', kickedRe ? kickedRe.reason : '未被拒');
  v2.close();
  await sleep(200);

  // 用主管理员踢自己场景不可行,验证上限:20000 分钟被截断为 10080
  // 先让受害者重新以不同昵称进入(避免永久禁令干扰),再用超限时长踢一个临时用户
  const victim2 = 'kick上限_' + t;
  const v3 = await connect();
  v3.send(JSON.stringify({ type: 'set_name', name: victim2 }));
  const ns3 = await waitMsg(v3, 'name_set');
  log(!!ns3, '第二名受害者进入: ' + victim2);
  admin.send(JSON.stringify({ type: 'admin_kick', name: victim2, duration_minutes: 20000 }));
  const kicked2 = await waitMsg(v3, 'kicked');
  log(!!kicked2 && kicked2.duration_minutes === 10080, '超限 20000 分钟被截断为 10080', kicked2 ? 'duration=' + kicked2.duration_minutes : '未收到');
  // 确认服务端禁令时间也被截断(通过重进提示验证)
  await sleep(200);
  const v4 = await connect();
  v4.send(JSON.stringify({ type: 'set_name', name: victim2 }));
  const re = await waitMsg(v4, 'kicked', 5000);
  log(!!re && re.reason.indexOf('10080') >= 0, '截断后禁令提示含10080分钟', re ? re.reason : '未被拒');
  v4.close();

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  admin.close(); v.close();
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('异常:', e.message); process.exit(1); });
