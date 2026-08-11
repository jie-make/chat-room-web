// 测试：撤回消息显示撤回者
// 场景：A 发消息 → B 撤回（需 B 为管理员或房主，这里用管理员权限测试）→ 校验广播带 by 且历史带 revoked_by
const WebSocket = require('ws');

const URL = 'ws://localhost:3000';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeClient(name, pass) {
  const ws = new WebSocket(URL);
  const inbox = [];
  ws.on('message', d => { try { inbox.push(JSON.parse(d)); } catch (e) {} });
  return { ws, inbox, name, pass };
}
function waitMsg(c, type, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const i = c.inbox.findIndex(m => m.type === type);
      if (i >= 0) { const m = c.inbox.splice(i, 1)[0]; clearInterval(iv); resolve(m); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); reject(new Error('timeout waiting ' + type + ' for ' + c.name)); }
    }, 50);
  });
}

(async () => {
  let pass = 0, fail = 0;
  const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };

  const admin = makeClient('jie_admin_t', '299427'); // 主管理员
  await waitMsg(admin, 'name_set');

  const guest = makeClient('guest_revoke_t' + Date.now() % 1000);
  await waitMsg(guest, 'name_set');

  // 管理员发一条群聊消息
  admin.ws.send(JSON.stringify({ type: 'chat', room_id: 'default', content: '待撤回的消息-' + Date.now(), content_type: 'text' }));
  const chatMsg = await waitMsg(admin, 'chat');
  const msgId = chatMsg.id;

  // 管理员撤回（管理员可撤回任意消息）
  admin.ws.send(JSON.stringify({ type: 'revoke', id: msgId, room_id: 'default' }));
  const revokeEvt = await waitMsg(admin, 'revoke');
  ok(revokeEvt.by === 'jie_admin_t', '撤回广播携带撤回者 by=' + revokeEvt.by);

  // 客户端收到广播也带 by
  const guestRevoke = await waitMsg(guest, 'revoke');
  ok(guestRevoke.by === 'jie_admin_t', '其他客户端收到 by=' + guestRevoke.by);

  // 拉取 default 历史,校验撤回消息带 revoked_by
  guest.ws.send(JSON.stringify({ type: 'get_group_history', room_id: 'default' }));
  const hist = await waitMsg(guest, 'history');
  const revokedMsg = hist.data.find(m => String(m.id) === String(msgId));
  ok(revokedMsg && revokedMsg.revoked === 1, '消息已标记撤回');
  ok(revokedMsg && revokedMsg.revoked_by === 'jie_admin_t', '历史中 revoked_by=' + (revokedMsg && revokedMsg.revoked_by));

  admin.ws.close(); guest.ws.close();
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
