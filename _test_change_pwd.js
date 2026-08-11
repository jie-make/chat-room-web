// 修改密码功能端到端测试
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
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
  console.log('========== 修改密码功能测试 ==========\n');

  console.log('[step 1] 注册用户修改密码');
  {
    const uname = 'cp' + ts, nick = '改密用户' + ts;
    const ws = await newWs();
    send(ws,{type:'register',username:uname,nickname:nick,password:'123456',remember:true});
    const rr = await waitType(ws,'register_result');
    if (!rr || !rr.ok) { fail('注册失败: ' + JSON.stringify(rr)); ws.close(); }
    else {
      ok('注册成功');
      // 用旧密码改密
      send(ws,{type:'change_password',old_password:'123456',new_password:'654321'});
      const cr = await waitType(ws,'change_pwd_result');
      if (cr && cr.ok) ok('改密成功');
      else { fail('改密失败: ' + JSON.stringify(cr)); ws.close(); }
      ws.close();
      // 旧密码登录应失败
      const ws2 = await newWs();
      send(ws2,{type:'login',username:uname,password:'123456'});
      const lr2 = await waitType(ws2,'login_result');
      if (lr2 && !lr2.ok) ok('旧密码登录被拒绝');
      else fail('旧密码仍可登录: ' + JSON.stringify(lr2));
      ws2.close();
      // 新密码登录应成功
      const ws3 = await newWs();
      send(ws3,{type:'login',username:uname,password:'654321',remember:true});
      const lr3 = await waitType(ws3,'login_result');
      if (lr3 && lr3.ok && lr3.token) ok('新密码登录成功,获得新 token');
      else fail('新密码登录失败: ' + JSON.stringify(lr3));
      // 旧 token(改密前的)应失效
      const oldToken = rr.token;
      if (oldToken) {
        const ws4 = await newWs();
        send(ws4,{type:'login',token:oldToken});
        const lr4 = await waitType(ws4,'login_result');
        if (lr4 && !lr4.ok) ok('改密后旧 token 已失效');
        else fail('旧 token 仍有效: ' + JSON.stringify(lr4));
        ws4.close();
      }
      ws3.close();
    }
  }

  console.log('[step 2] 旧密码错误时改密被拒');
  {
    const uname = 'cp2' + ts;
    const ws = await newWs();
    send(ws,{type:'register',username:uname,nickname:'改密用户2' + ts,password:'123456'});
    await waitType(ws,'register_result');
    send(ws,{type:'change_password',old_password:'wrong',new_password:'654321'});
    const cr = await waitType(ws,'change_pwd_result');
    if (cr && !cr.ok && cr.error.indexOf('旧密码') >= 0) ok('正确拒绝: ' + cr.error);
    else fail('未正确拒绝: ' + JSON.stringify(cr));
    ws.close();
  }

  console.log('[step 3] 主管理员修改密码(会同步 .env)');
  {
    const ws = await newWs();
    send(ws,{type:'login',username:'jie',password:'299427',remember:true});
    const lr = await waitType(ws,'login_result');
    if (!lr || !lr.ok) { fail('主管理员登录失败: ' + JSON.stringify(lr)); ws.close(); }
    else {
      ok('主管理员账号登录成功');
      send(ws,{type:'change_password',old_password:'299427',new_password:'123456'});
      const cr = await waitType(ws,'change_pwd_result');
      if (cr && cr.ok) ok('主管理员改密成功');
      else { fail('主管理员改密失败: ' + JSON.stringify(cr)); ws.close(); }
      ws.close();
      // 新密码快速进入应成功
      const ws2 = await newWs();
      send(ws2,{type:'set_name',name:'jie',password:'123456'});
      const ns2 = await waitType(ws2,'name_set');
      if (ns2 && ns2.is_super_admin) ok('新密码快速进入成功');
      else fail('新密码快速进入失败: ' + JSON.stringify(ns2));
      ws2.close();
      // 旧密码快速进入应失败
      const ws3 = await newWs();
      send(ws3,{type:'set_name',name:'jie',password:'299427'});
      const ne3 = await waitType(ws3,'name_error');
      if (ne3) ok('旧密码快速进入被拒绝');
      else fail('旧密码快速进入未被拒绝');
      ws3.close();
      // 检查 .env
      const env = fs.readFileSync(path.join(__dirname,'.env'),'utf8');
      if (/ADMIN_PASSWORD\s*=\s*123456/.test(env)) ok('.env 中 ADMIN_PASSWORD 已同步为 123456');
      else fail('.env 未同步: ' + (env.match(/ADMIN_PASSWORD.*/g) || ['(未找到)']).join('; '));
    }
  }

  console.log('[step 4] 恢复主管理员密码为 299427');
  {
    const ws = await newWs();
    send(ws,{type:'login',username:'jie',password:'123456',remember:true});
    const lr = await waitType(ws,'login_result');
    if (!lr || !lr.ok) { fail('新密码登录失败,无法恢复: ' + JSON.stringify(lr)); ws.close(); }
    else {
      send(ws,{type:'change_password',old_password:'123456',new_password:'299427'});
      const cr = await waitType(ws,'change_pwd_result');
      if (cr && cr.ok) ok('密码已恢复为 299427');
      else fail('恢复失败: ' + JSON.stringify(cr));
      ws.close();
      // 验证 .env 恢复
      const env = fs.readFileSync(path.join(__dirname,'.env'),'utf8');
      if (/ADMIN_PASSWORD\s*=\s*299427/.test(env)) ok('.env 已恢复为 299427');
      else fail('.env 恢复异常: ' + (env.match(/ADMIN_PASSWORD.*/g) || ['(未找到)']).join('; '));
      // 验证旧密码(299427)快速进入恢复
      const ws2 = await newWs();
      send(ws2,{type:'set_name',name:'jie',password:'299427'});
      const ns2 = await waitType(ws2,'name_set');
      if (ns2 && ns2.is_super_admin) ok('299427 快速进入恢复生效');
      else fail('299427 快速进入未生效: ' + JSON.stringify(ns2));
      ws2.close();
    }
  }

  console.log('\n========== 测试结果 ==========');
  console.log('  通过: ' + passed + ' / ' + (passed + failed));
  process.exit(failed > 0 ? 1 : 0);
}
test();
