// 上传可追溯性端到端测试: 注册用户上传文件 -> 管理员查询上传记录
const WebSocket = require('ws');
const http = require('http');
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
  function waitMsg(timeout = 4000) {
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
async function waitType(ws, type, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const msg = await ws.waitMsg(timeout - (Date.now() - start));
    if (!msg) return null;
    if (msg.type === type) return msg;
  }
  return null;
}
// 上传文件(返回 Promise<{status, body}>)
function uploadFile({ fileName, mime, content, headers = {} }) {
  return new Promise((resolve) => {
    const boundary = '----testboundary' + Date.now();
    const body = Buffer.concat([
      Buffer.from('--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="file"; filename="' + fileName + '"\r\n' +
        'Content-Type: ' + mime + '\r\n\r\n'),
      Buffer.from(content),
      Buffer.from('\r\n--' + boundary + '--\r\n')
    ]);
    const req = http.request({
      host: 'localhost', port: 3000, path: '/upload', method: 'POST',
      headers: Object.assign({
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length,
        'X-File-Name': fileName, 'X-File-Mime': mime
      }, headers)
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', e => resolve({ status: 0, body: String(e) }));
    req.end(body);
  });
}

async function test() {
  console.log('========== 上传可追溯性端到端测试 ==========\n');
  const nick = 'traceUser' + ts;
  const jie = await newWs();
  const user = await newWs();

  console.log('[step 1] 主管理员 jie 登录');
  send(jie, { type: 'login', username: 'jie', password: '299427', remember: true });
  const lr = await waitType(jie, 'login_result');
  if (lr && lr.ok && lr.is_admin) ok('jie 已登录(管理员)');
  else { fail('管理员登录失败: ' + JSON.stringify(lr)); process.exit(1); }

  console.log('[step 2] 注册测试用户并获取 token');
  send(user, { type: 'register', username: 'tu' + ts, nickname: nick, password: 'pass123456', remember: true });
  const rr = await waitType(user, 'register_result');
  if (rr && rr.ok && rr.token) ok('注册成功, token=' + rr.token.slice(0, 12) + '...');
  else { fail('注册失败: ' + JSON.stringify(rr)); process.exit(1); }

  console.log('[step 3] 注册用户上传文件(携带身份头)');
  const up1 = await uploadFile({
    fileName: 'trace-test.txt', mime: 'text/plain', content: 'traceability test content ' + ts,
    headers: { 'X-Uploader': nick, 'X-Token': rr.token, 'X-Room-Id': 'default' }
  });
  if (up1.status === 200) ok('上传成功: ' + JSON.parse(up1.body).name + ' -> ' + JSON.parse(up1.body).url);
  else { fail('上传失败: ' + up1.status + ' ' + up1.body); process.exit(1); }
  await sleep(3500);

  console.log('[step 4] 临时用户上传文件(仅昵称,无 token)');
  send(user, { type: 'logout' });
  await sleep(300);
  const guest = await newWs();
  send(guest, { type: 'set_name', name: 'traceGuest' + ts });
  if (await waitType(guest, 'name_set')) ok('临时用户已进入');
  const up2 = await uploadFile({
    fileName: 'guest-file.bin', mime: 'application/octet-stream', content: Buffer.from([1, 2, 3, 4, 5]),
    headers: { 'X-Uploader': 'traceGuest' + ts, 'X-Room-Id': 'testroom' }
  });
  if (up2.status === 200) ok('临时用户上传成功');
  else { fail('临时用户上传失败: ' + up2.status + ' ' + up2.body); process.exit(1); }
  await sleep(3500);

  console.log('[step 5] 管理员查询上传记录');
  send(jie, { type: 'admin_list_uploads', limit: 50 });
  const ul = await waitType(jie, 'admin_upload_list');
  if (!ul || !Array.isArray(ul.data)) { fail('未收到上传记录: ' + JSON.stringify(ul)); process.exit(1); }
  const rec1 = ul.data.find(r => r.file_name === 'trace-test.txt');
  const rec2 = ul.data.find(r => r.file_name === 'guest-file.bin');
  if (rec1) {
    ok('找到注册用户上传记录');
    if (rec1.uploader === nick) ok('  uploader 正确: ' + rec1.uploader); else fail('  uploader 错误: ' + rec1.uploader);
    if (rec1.user_id) ok('  user_id 已记录: ' + rec1.user_id); else fail('  user_id 缺失');
    if (rec1.ip) ok('  ip 已记录: ' + rec1.ip); else fail('  ip 缺失');
    if (rec1.room_id === 'default') ok('  room_id 正确'); else fail('  room_id 错误: ' + rec1.room_id);
    if (rec1.size > 0) ok('  size 已记录: ' + rec1.size); else fail('  size 缺失');
    if (rec1.is_image === false || rec1.is_image === 0) ok('  is_image 正确(文件)'); else fail('  is_image 错误');
  } else { fail('未找到注册用户上传记录'); }

  if (rec2) {
    ok('找到临时用户上传记录');
    if (rec2.user_id === null || rec2.user_id === undefined) ok('  user_id 为空(临时用户)'); else fail('  临时用户竟有 user_id: ' + rec2.user_id);
    if (rec2.room_id === 'testroom') ok('  room_id 正确'); else fail('  room_id 错误: ' + rec2.room_id);
  } else { fail('未找到临时用户上传记录'); }

  console.log('[step 6] 管理员搜索上传记录');
  send(jie, { type: 'admin_list_uploads', kw: nick, limit: 50 });
  const ul2 = await waitType(jie, 'admin_upload_list');
  if (ul2 && ul2.data.length === 1 && ul2.data[0].uploader === nick) ok('按 uploader 搜索命中 1 条');
  else fail('搜索异常: ' + JSON.stringify(ul2 && ul2.data && ul2.data.length));

  console.log('[step 7] 非管理员无权查询');
  const g2 = await newWs();
  send(g2, { type: 'set_name', name: 'noauth' + ts });
  await waitType(g2, 'name_set');
  send(g2, { type: 'admin_list_uploads' });
  const denied = await waitType(g2, 'notice');
  if (denied && denied.text.indexOf('无权') >= 0) ok('非管理员被拒绝: ' + denied.text);
  else fail('非管理员未被拒绝: ' + JSON.stringify(denied));

  guest.close(); g2.close(); user.close(); jie.close();
  console.log('\n========== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ==========');
  process.exit(failed ? 1 : 0);
}
test();
