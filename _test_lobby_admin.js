// 公共大厅房管功能限制测试
const WebSocket = require('ws');
const URL = 'ws://localhost:3000';
let passed = 0, failed = 0;
const ts = Date.now();
function ok(m){passed++;console.log('  ✅ ' + m);}
function fail(m){failed++;console.log('  ❌ ' + m);}
function send(ws,obj){ws.send(JSON.stringify(obj));}
function waitMsg(ws,timeout=3000){return new Promise(r=>{let t=setTimeout(()=>r(null),timeout);ws.once('message',raw=>{clearTimeout(t);try{r(JSON.parse(raw.toString()))}catch(e){r(null)}});});}
async function waitType(ws,type,timeout=3000){const s=Date.now();while(Date.now()-s<timeout){const m=await waitMsg(ws,timeout-(Date.now()-s));if(!m)return null;if(m.type===type)return m;}return null;}
function newWs(){const ws=new WebSocket(URL);return new Promise(r=>ws.on('open',()=>r(ws)));}

async function test(){
  console.log('========== 公共大厅房管功能限制测试 ==========\n');
  const ws = await newWs();
  send(ws,{type:'login',username:'jie',password:'299427',remember:true});
  const lr = await waitType(ws,'login_result');
  if (!lr || !lr.ok) { fail('主管理员登录失败: ' + JSON.stringify(lr)); process.exit(1); }
  ok('主管理员已登录');

  // 1. 公共大厅:修改名称被拒
  console.log('[step 1] 公共大厅修改名称/密码/类型被拒');
  send(ws,{type:'update_room',room_id:'default',name:'改名测试' + ts});
  let m = await waitType(ws,'notice');
  if (m && m.text.indexOf('公共大厅') >= 0) ok('改名被拒: ' + m.text);
  else fail('改名未被拒: ' + JSON.stringify(m));
  send(ws,{type:'update_room',room_id:'default',password:'123456'});
  m = await waitType(ws,'notice');
  if (m && m.text.indexOf('公共大厅') >= 0) ok('改密被拒: ' + m.text);
  else fail('改密未被拒: ' + JSON.stringify(m));
  send(ws,{type:'update_room',room_id:'default',is_private:true});
  m = await waitType(ws,'notice');
  if (m && m.text.indexOf('公共大厅') >= 0) ok('改类型被拒: ' + m.text);
  else fail('改类型未被拒: ' + JSON.stringify(m));

  // 2. 公共大厅:转让房主被拒
  console.log('[step 2] 公共大厅转让房主被拒');
  send(ws,{type:'transfer_owner',room_id:'default',new_owner:'mod1'});
  m = await waitType(ws,'notice');
  if (m && m.text.indexOf('公共大厅') >= 0) ok('转让被拒: ' + m.text);
  else fail('转让未被拒: ' + JSON.stringify(m));

  // 3. 公共大厅:踢出被拒
  console.log('[step 3] 公共大厅踢出房间被拒');
  send(ws,{type:'room_kick',room_id:'default',name:'mod1',duration:60});
  m = await waitType(ws,'notice');
  if (m && m.text.indexOf('公共大厅') >= 0) ok('踢出被拒: ' + m.text);
  else fail('踢出未被拒: ' + JSON.stringify(m));

  // 4. 公共大厅:禁言仍可用
  console.log('[step 4] 公共大厅禁言仍可用');
  send(ws,{type:'room_mute',room_id:'default',muted:true});
  m = await waitType(ws,'room_mute_changed');
  if (m && m.room_id === 'default' && m.muted === true) ok('公共大厅禁言生效');
  else fail('公共大厅禁言失败: ' + JSON.stringify(m));
  send(ws,{type:'room_mute',room_id:'default',muted:false});
  m = await waitType(ws,'room_mute_changed');
  if (m && m.muted === false) ok('公共大厅解除禁言成功(已恢复)');
  else fail('解除禁言失败: ' + JSON.stringify(m));

  // 5. 普通房间:改名/踢出仍正常
  console.log('[step 5] 普通房间房管功能未受影响');
  send(ws,{type:'create_room',name:'房管测试房间' + ts});
  const rc = await waitType(ws,'room_created');
  if (!rc || !rc.room) { fail('创建房间失败: ' + JSON.stringify(rc)); ws.close(); process.exit(1); }
  const rid = rc.room.id;
  ok('创建普通房间: ' + rid);
  send(ws,{type:'join_room',room_id:rid});
  const rj = await waitType(ws,'room_joined');
  if (!rj) { fail('加入房间失败'); ws.close(); process.exit(1); }
  send(ws,{type:'update_room',room_id:rid,name:'改名后房间' + ts});
  m = await waitType(ws,'room_updated');
  if (m && m.room && m.room.name.indexOf('改名后房间') >= 0) ok('普通房间改名成功');
  else fail('普通房间改名失败: ' + JSON.stringify(m));
  // 清理:删除测试房间
  send(ws,{type:'delete_room',room_id:rid});
  m = await waitType(ws,'room_deleted');
  if (m) ok('测试房间已清理');
  else fail('测试房间清理失败');

  ws.close();
  console.log('\n========== 测试结果 ==========');
  console.log('  通过: ' + passed + ' / ' + (passed + failed));
  process.exit(failed > 0 ? 1 : 0);
}
test();
