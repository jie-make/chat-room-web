// 房间"管理"头衔功能测试(需以 DISABLE_IP_LIMIT=1 启动服务以支持多用户并发)
const WebSocket = require('ws');
const URL = 'ws://localhost:3000';
let passed = 0, failed = 0;
const ts = Date.now();
function ok(m){passed++;console.log('  ✅ ' + m);}
function fail(m){failed++;console.log('  ❌ ' + m);}
function send(ws,obj){ws.send(JSON.stringify(obj));}

function attachQueue(ws) {
  const queue = [], waiters = [];
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (waiters.length > 0) waiters.shift().resolve(msg); else queue.push(msg);
  });
  function waitMsg(timeout = 3000) {
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
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function test(){
  console.log('========== 房间"管理"头衔功能测试 ==========\n');
  const nameA = '管理测试A' + ts, nameB = '管理测试B' + ts, nameC = '管理测试C' + ts;
  const jie = await newWs(), A = await newWs(), B = await newWs(), C = await newWs();

  console.log('[step 1] 登录/进入并创建房间');
  send(jie,{type:'login',username:'jie',password:'299427',remember:true});
  const lr = await waitType(jie,'login_result');
  if (!lr || !lr.ok) { fail('主管理员登录失败'); process.exit(1); }
  ok('主管理员 jie 已登录');
  send(A,{type:'set_name',name:nameA});
  send(B,{type:'set_name',name:nameB});
  send(C,{type:'set_name',name:nameC});
  if (await waitType(A,'name_set') && await waitType(B,'name_set') && await waitType(C,'name_set')) ok('A/B/C 已进入');
  else { fail('用户进入失败'); process.exit(1); }

  send(jie,{type:'create_room',name:'管理测试房' + ts});
  const rc = await waitType(jie,'room_created');
  if (!rc || !rc.room) { fail('创建房间失败'); process.exit(1); }
  const rid = rc.room.id;
  ok('创建房间: ' + rid);
  send(jie,{type:'join_room',room_id:rid});
  await waitType(jie,'room_joined');
  send(A,{type:'join_room',room_id:rid});
  await waitType(A,'room_joined');
  send(B,{type:'join_room',room_id:rid});
  await waitType(B,'room_joined');
  send(C,{type:'join_room',room_id:rid});
  await waitType(C,'room_joined');
  ok('4 人已全部加入房间');

  console.log('[step 2] 房主 jie 设置 A 为房间"管理"');
  send(jie,{type:'set_room_manager',room_id:rid,name:nameA,on:true});
  const mg1 = await waitType(jie,'room_managers_changed');
  if (mg1 && Array.isArray(mg1.managers) && mg1.managers.indexOf(nameA) >= 0) ok('房主成功设置管理,managers=' + mg1.managers.join(','));
  else fail('设置管理失败: ' + JSON.stringify(mg1));
  const noticeA = await waitType(A,'notice');
  if (noticeA && noticeA.text.indexOf('管理') >= 0) ok('A 收到通知: ' + noticeA.text);
  else fail('A 未收到通知: ' + JSON.stringify(noticeA));

  console.log('[step 3] 管理员(jie)也可设置管理');
  send(jie,{type:'set_room_manager',room_id:rid,name:nameC,on:true});
  const mgC = await waitType(jie,'room_managers_changed');
  if (mgC && mgC.managers.indexOf(nameC) >= 0) ok('管理员设置 C 为管理成功');
  else fail('管理员设置 C 失败: ' + JSON.stringify(mgC));
  await waitType(C,'notice');

  console.log('[step 4] 房间"管理" A 可踢普通成员 B');
  send(A,{type:'room_kick',room_id:rid,name:nameB,duration:60});
  const kicked = await waitType(B,'room_kicked');
  if (kicked && kicked.room_id === rid) ok('B 被 A 踢出房间');
  else fail('B 未被踢出: ' + JSON.stringify(kicked));
  // A 收到房间 offline 广播
  const offA = await waitType(A,'offline');
  if (offA && offA.name === nameB) ok('房间广播 offline(B)');
  else fail('未收到 offline 广播: ' + JSON.stringify(offA));

  console.log('[step 5] 房间"管理" A 无法踢房主 jie');
  send(A,{type:'room_kick',room_id:rid,name:'jie',duration:60});
  const n1 = await waitType(A,'notice');
  if (n1 && n1.text.indexOf('不能踢房主') >= 0) ok('A 踢房主被拒: ' + n1.text);
  else fail('A 踢房主未被拒: ' + JSON.stringify(n1));

  console.log('[step 6] 房间"管理" A 无法踢其他房间管理 C');
  send(A,{type:'room_kick',room_id:rid,name:nameC,duration:60});
  const n2 = await waitType(A,'notice');
  if (n2 && n2.text.indexOf('不能踢房间管理') >= 0) ok('A 踢管理被拒: ' + n2.text);
  else fail('A 踢管理未被拒: ' + JSON.stringify(n2));

  console.log('[step 7] 房间"管理" A 无法设置管理(仅房主/管理员可)');
  send(A,{type:'set_room_manager',room_id:rid,name:nameB,on:true});
  const n3 = await waitType(A,'notice');
  if (n3 && n3.text.indexOf('仅房主或管理员') >= 0) ok('A 设置管理被拒: ' + n3.text);
  else fail('A 设置管理未被拒: ' + JSON.stringify(n3));

  console.log('[step 8] 房间"管理" A 可禁言房间');
  send(A,{type:'room_mute',room_id:rid,muted:true});
  const mc = await waitType(A,'room_mute_changed');
  if (mc && mc.room_id === rid && mc.muted === true) ok('A 开启房间禁言成功');
  else fail('A 禁言失败: ' + JSON.stringify(mc));
  send(jie,{type:'room_mute',room_id:rid,muted:false});
  await waitType(jie,'room_mute_changed');

  console.log('[step 9] 房主取消 A 的管理头衔');
  send(jie,{type:'set_room_manager',room_id:rid,name:nameA,on:false});
  const mg2 = await waitType(jie,'room_managers_changed');
  if (mg2 && mg2.managers.indexOf(nameA) < 0) ok('A 管理已取消,managers=' + JSON.stringify(mg2.managers));
  else fail('取消管理失败: ' + JSON.stringify(mg2));
  const cancelNotice = await waitType(A,'notice');
  if (cancelNotice && cancelNotice.text.indexOf('取消') >= 0) ok('A 收到取消通知: ' + cancelNotice.text);
  else fail('A 未收到取消通知: ' + JSON.stringify(cancelNotice));

  console.log('[step 10] 持久化:重新设置 A 管理后,退出房间再加入保留头衔');
  send(jie,{type:'set_room_manager',room_id:rid,name:nameA,on:true});
  await waitType(jie,'room_managers_changed');
  await waitType(A,'notice');
  send(A,{type:'leave_room',room_id:rid});
  await waitType(A,'room_left');
  send(A,{type:'join_room',room_id:rid});
  const rjA = await waitType(A,'room_joined');
  if (rjA && rjA.room && Array.isArray(rjA.room.managers) && rjA.room.managers.indexOf(nameA) >= 0) ok('A 重新加入后仍为房间管理');
  else fail('A 重新加入后头衔丢失: ' + JSON.stringify(rjA));

  console.log('[step 11] 房主离开房间再进入仍是房主');
  send(jie,{type:'leave_room',room_id:rid});
  await waitType(jie,'room_left');
  send(jie,{type:'join_room',room_id:rid});
  const rjJ = await waitType(jie,'room_joined');
  if (rjJ && rjJ.room && rjJ.room.owner === 'jie') ok('jie 重新加入后仍为房主');
  else fail('jie 重新加入后非房主: ' + JSON.stringify(rjJ));

  console.log('[step 12] 设置管理时目标必须在线(不在线被拒)');
  send(jie,{type:'set_room_manager',room_id:rid,name:'离线用户XYZ',on:true});
  const n4 = await waitType(jie,'notice');
  if (n4 && n4.text.indexOf('不在当前房间') >= 0) ok('离线用户被拒: ' + n4.text);
  else fail('离线用户未被拒: ' + JSON.stringify(n4));

  console.log('[step 13] 普通用户 A 被取消管理后无法再踢人');
  send(jie,{type:'set_room_manager',room_id:rid,name:nameA,on:false});
  await waitType(jie,'room_managers_changed');
  await waitType(A,'notice'); // 先消费"头衔已被取消"通知
  send(A,{type:'room_kick',room_id:rid,name:nameC,duration:60});
  const n5 = await waitType(A,'notice');
  if (n5 && n5.text.indexOf('无权操作') >= 0) ok('取消管理后踢人被拒: ' + n5.text);
  else fail('取消管理后仍可踢人: ' + JSON.stringify(n5));

  // 清理
  send(jie,{type:'delete_room',room_id:rid});
  await waitType(jie,'room_deleted');

  jie.close(); A.close(); B.close(); C.close();
  await sleep(300);
  console.log('\n========== 测试结果 ==========');
  console.log('  通过: ' + passed + ' / ' + (passed + failed));
  process.exit(failed > 0 ? 1 : 0);
}
test();
