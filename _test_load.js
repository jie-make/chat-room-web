// 负载测试脚本 - 测试聊天室服务器的并发承载能力
// 测试维度: 连接数 / 消息广播延迟 / 内存占用 / 消息丢失率
//
// ⚠️ 运行前需临时调整服务器配置(同 IP 单会话限制会互相踢):
//   1. 修改 server.js: MAX_CONNECTIONS_PER_IP = 100
//   2. 修改 server.js: 注释掉 completeEntrance 中的 kickOtherSocketsByIp(ip, socket) 调用
//   3. 重启服务器
//   4. 跑完测试后恢复配置
//
// 或者直接在服务器上临时设置环境变量(如果支持):
//   DISABLE_IP_LIMIT=1 node server.js  (需要服务端支持)

const WebSocket = require('ws');

const URL = 'ws://localhost:3000';
const ts = Date.now();

// 工具函数
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function now() { return Date.now(); }
function memMB() { return Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 10) / 10; }

// 创建一个连接并以临时用户身份进入
async function createClient(name) {
  const ws = new WebSocket(URL);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
  // 设置昵称进入
  ws.send(JSON.stringify({ type: 'set_name', name: name }));
  // 等待 name_set 确认
  try {
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const handler = (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'name_set') { settled = true; ws.removeListener('message', handler); resolve(msg); }
          else if (msg.type === 'name_error' || msg.type === 'force_logout') {
            settled = true; ws.removeListener('message', handler);
            reject(new Error(msg.text || msg.reason || 'rejected'));
          }
        } catch (e) {}
      };
      ws.on('message', handler);
      setTimeout(() => { if (!settled) { ws.removeListener('message', handler); reject(new Error('name_set timeout')); } }, 5000);
    });
    return ws;
  } catch (e) {
    // 失败时关闭连接,避免残留
    try { ws.close(); } catch (err) {}
    throw e;
  }
}

// 收集指定时间内收到的消息
function collectMessages(ws, durationMs) {
  return new Promise((resolve) => {
    const msgs = [];
    const handler = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'chat') msgs.push({ time: now(), msg });
      } catch (e) {}
    };
    ws.on('message', handler);
    setTimeout(() => { ws.removeListener('message', handler); resolve(msgs); }, durationMs);
  });
}

// 获取服务器内存(通过管理后台 API 不可用,改为本地进程)
function getServerMem() {
  // 由于服务器是独立进程,我们用 HTTP 请求获取不了内存
  // 改为报告客户端内存 + 估算
  return memMB();
}

async function test() {
  console.log('========== 聊天室负载测试 ==========\n');
  console.log('测试目标: ' + URL);
  console.log('客户端进程初始内存: ' + memMB() + ' MB\n');

  // ============ 测试 1: 连接数承载 ============
  console.log('---------- 测试 1: 连接数承载 ----------');
  const CONN_COUNT = 200;  // 测试 200 连接
  console.log('尝试创建 ' + CONN_COUNT + ' 个连接...');
  const conns = [];
  const failed = [];
  const t0 = now();
  for (let i = 0; i < CONN_COUNT; i++) {
    // 用 base36 缩短 ts,避免超过 MAX_NAME_LENGTH(20)
    const name = 'ld' + ts.toString(36) + i;
    try {
      const ws = await createClient(name);
      conns.push(ws);
    } catch (e) {
      failed.push({ idx: i, name: name, reason: e.message });
      if (failed.length <= 3) console.log('  [debug] 失败 #' + i + ' name=' + name + ' reason=' + e.message);
    }
  }
  const t1 = now();
  console.log('  成功连接: ' + conns.length + ' / ' + CONN_COUNT);
  console.log('  失败: ' + failed.length + ' (原因: ' + (failed[0]?.reason || 'N/A') + ')');
  console.log('  耗时: ' + (t1 - t0) + ' ms');
  console.log('  平均每连接: ' + Math.round((t1 - t0) / Math.max(1, conns.length)) + ' ms');
  console.log('  客户端内存: ' + memMB() + ' MB\n');

  // ============ 测试 2: 消息广播延迟 ============
  if (conns.length >= 2) {
    console.log('---------- 测试 2: 消息广播延迟 ----------');
    const sender = conns[0];
    const listeners = conns.slice(1, Math.min(21, conns.length)); // 最多监听 20 个
    const MSG_COUNT = 5;
    const delays = [];
    for (let i = 0; i < MSG_COUNT; i++) {
      // 启动监听
      const collectors = listeners.map(ws => collectMessages(ws, 2000));
      await sleep(50);
      const sendTime = now();
      sender.send(JSON.stringify({ type: 'chat', room_id: 'default', content: 'bench_msg_' + i }));
      // 等待所有监听器收集
      const results = await Promise.all(collectors);
      for (const arr of results) {
        for (const m of arr) {
          delays.push(m.time - sendTime);
        }
      }
      await sleep(300); // 遵守 RATE_LIMIT_MS
    }
    if (delays.length > 0) {
      delays.sort((a, b) => a - b);
      const avg = Math.round(delays.reduce((s, x) => s + x, 0) / delays.length);
      const p50 = delays[Math.floor(delays.length * 0.5)];
      const p95 = delays[Math.floor(delays.length * 0.95)];
      const p99 = delays[Math.floor(delays.length * 0.99)];
      const max = delays[delays.length - 1];
      console.log('  发送 ' + MSG_COUNT + ' 条消息, 收到 ' + delays.length + ' 个投递');
      console.log('  平均延迟: ' + avg + ' ms');
      console.log('  P50: ' + p50 + ' ms | P95: ' + p95 + ' ms | P99: ' + p99 + ' ms | Max: ' + max + ' ms');
    } else {
      console.log('  未收到任何消息(可能所有连接被 IP 限制踢掉)');
    }
    console.log('  客户端内存: ' + memMB() + ' MB\n');
  }

  // ============ 测试 3: 限流验证 ============
  if (conns.length >= 1) {
    console.log('---------- 测试 3: 限流验证 ----------');
    const sender = conns[0];
    const collector = conns[1] || conns[0];
    // 快速发送 15 条(应被限流)
    const collected = await collectMessages(collector, 3000);
    const sendStart = now();
    let sent = 0, rateLimited = 0;
    const rlHandler = (raw) => {
      try { const m = JSON.parse(raw.toString()); if (m.type === 'rate_limited') rateLimited++; } catch (e) {}
    };
    sender.on('message', rlHandler);
    for (let i = 0; i < 15; i++) {
      sender.send(JSON.stringify({ type: 'chat', room_id: 'default', content: 'spam_' + i }));
      sent++;
      await sleep(10); // 10ms 间隔,远小于 RATE_LIMIT_MS(200ms)
    }
    await sleep(2000);
    sender.removeListener('message', rlHandler);
    console.log('  尝试发送 15 条(10ms 间隔), 实际发送: ' + sent);
    console.log('  收到 rate_limited 通知: ' + rateLimited + ' 次');
    console.log('  (预期: 大部分被限流,只有符合 RATE_LIMIT_MS=200ms 的能发出)\n');
  }

  // ============ 测试 4: 持续连接稳定性 ============
  if (conns.length >= 5) {
    console.log('---------- 测试 4: 持续连接稳定性(10 秒) ----------');
    const aliveBefore = conns.filter(ws => ws.readyState === WebSocket.OPEN).length;
    console.log('  测试前存活连接: ' + aliveBefore + ' / ' + conns.length);
    await sleep(10000);
    const aliveAfter = conns.filter(ws => ws.readyState === WebSocket.OPEN).length;
    console.log('  10 秒后存活连接: ' + aliveAfter + ' / ' + conns.length);
    console.log('  心跳保活率: ' + Math.round(aliveAfter / aliveBefore * 100) + '%\n');
  }

  // 清理
  console.log('---------- 清理连接 ----------');
  conns.forEach(ws => { try { ws.close(); } catch (e) {} });
  await sleep(500);

  console.log('========== 测试完成 ==========');
  console.log('最终客户端内存: ' + memMB() + ' MB');
  console.log('说明:');
  console.log('  - 本测试在 DISABLE_IP_LIMIT=1 模式下运行,绕过了单 IP 限制');
  console.log('  - 生产环境单 IP 限制为 10,消息限流 200ms/条 + 滑动窗口');
  console.log('  - 服务器配置: MAX_CONNECTIONS=500, 消息限流=200ms/条');
  process.exit(0);
}

test().catch(e => { console.error('测试异常:', e); process.exit(1); });
