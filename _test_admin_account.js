// 主管理员注册为账户后:通过"账号登录"验证
const WebSocket = require('ws');
const URL = 'ws://localhost:3000';
let passed = 0, failed = 0;
function ok(m){passed++;console.log('  ✅ ' + m);}
function fail(m){failed++;console.log('  ❌ ' + m);}
function send(ws,obj){ws.send(JSON.stringify(obj));}
function waitMsg(ws,timeout=3000){return new Promise(r=>{let t=setTimeout(()=>r(null),timeout);ws.once('message',raw=>{clearTimeout(t);try{r(JSON.parse(raw.toString()))}catch(e){r(null)}});});}
async function waitType(ws,type,timeout=3000){const s=Date.now();while(Date.now()-s<timeout){const m=await waitMsg(ws,timeout-(Date.now()-s));if(!m)return null;if(m.type===type)return m;}return null;}

async function test(){
  console.log('========== 主管理员账号登录测试 ==========\n');

  console.log('[step 1] 主管理员通过账号登录(jie/299427)');
  {
    const ws = new WebSocket(URL);
    await new Promise(r=>ws.on('open',r));
    send(ws,{type:'login',username:'jie',password:'299427',remember:true});
    const lr = await waitType(ws,'login_result');
    if (lr && lr.ok && lr.is_super_admin && lr.token) ok('login_result ok, 带token, is_super_admin=true');
    else fail('login_result 异常: ' + JSON.stringify(lr));
    const ns = await waitType(ws,'name_set');
    if (ns && ns.is_super_admin && ns.is_admin) ok('name_set 超管身份正确');
    else fail('name_set 异常: ' + JSON.stringify(ns));
    send(ws,{type:'admin_list_admins'});
    const al = await waitType(ws,'admin_list');
    if (al && Array.isArray(al.data) && al.data.length > 0 && al.data[0].is_super) ok('超管权限生效: 可查看管理员列表');
    else fail('admin_list 异常: ' + JSON.stringify(al));
    ws.close();
  }

  console.log('[step 2] 主管理员账号登录-错误密码');
  {
    const ws = new WebSocket(URL);
    await new Promise(r=>ws.on('open',r));
    send(ws,{type:'login',username:'jie',password:'wrong'});
    const lr = await waitType(ws,'login_result');
    if (lr && !lr.ok) ok('错误密码被拒绝: ' + lr.error);
    else fail('错误密码未被拒绝: ' + JSON.stringify(lr));
    ws.close();
  }

  console.log('[step 3] 注册保留用户名 jie');
  {
    const ws = new WebSocket(URL);
    await new Promise(r=>ws.on('open',r));
    send(ws,{type:'register',username:'jie',nickname:'x' + Date.now(),password:'123456'});
    const rr = await waitType(ws,'register_result');
    if (rr && !rr.ok) ok('保留用户名被拒绝: ' + rr.error);
    else fail('保留用户名未被拒绝: ' + JSON.stringify(rr));
    ws.close();
  }

  console.log('[step 4] 主管理员账号登录踢掉快速进入旧连接(单点登录)');
  {
    const ws1 = new WebSocket(URL);
    await new Promise(r=>ws1.on('open',r));
    send(ws1,{type:'set_name',name:'jie',password:'299427'});
    const ns1 = await waitType(ws1,'name_set');
    if (!ns1 || !ns1.is_super_admin) { fail('快速进入登录失败: ' + JSON.stringify(ns1)); ws1.close(); }
    else ok('快速进入已登录');
    const flPromise = waitType(ws1,'force_logout',4000);
    const ws2 = new WebSocket(URL);
    await new Promise(r=>ws2.on('open',r));
    send(ws2,{type:'login',username:'jie',password:'299427'});
    const lr = await waitType(ws2,'login_result');
    const fl = await flPromise;
    if (lr && lr.ok) ok('账号登录成功');
    else fail('账号登录失败: ' + JSON.stringify(lr));
    if (fl) ok('旧连接被踢下线: ' + fl.reason);
    else fail('旧连接未被踢下线');
    ws1.close(); ws2.close();
  }

  console.log('\n========== 测试结果 ==========');
  console.log('  通过: ' + passed + ' / ' + (passed + failed));
  process.exit(failed > 0 ? 1 : 0);
}
test();
