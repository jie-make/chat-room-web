# 聊天室数据库清理工具（命令行版本）
# 可视化版本已集成到聊天室管理后台（管理员控制台 → 清理后台）
# 此脚本作为备选方案，可在服务未运行时使用
# 用法: 右键"清理数据库.bat"以管理员身份运行

$ErrorActionPreference = 'Stop'
$ProjectRoot = 'D:\ChatRoom'
$UploadsDir = Join-Path $ProjectRoot 'public\uploads'

# 读取 .env 配置
$envFile = Join-Path $ProjectRoot '.env'
$mysqlHost = '127.0.0.1'
$mysqlPort = '3306'
$mysqlUser = 'root'
$mysqlPassword = ''
$mysqlDatabase = 'chat_db'

if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*MYSQL_(HOST|PORT|USER|PASSWORD|DATABASE)\s*=\s*(.+)\s*$') {
            $key = $matches[1]
            $val = $matches[2].Trim('"').Trim("'")
            switch ($key) {
                'HOST' { $mysqlHost = $val }
                'PORT' { $mysqlPort = $val }
                'USER' { $mysqlUser = $val }
                'PASSWORD' { $mysqlPassword = $val }
                'DATABASE' { $mysqlDatabase = $val }
            }
        }
    }
}

function Show-Menu {
    Clear-Host
    Write-Host '======================================' -ForegroundColor Cyan
    Write-Host '  聊天室数据库清理工具(命令行版)' -ForegroundColor Cyan
    Write-Host '======================================' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '  [1] 查看统计信息'
    Write-Host '  [2] 清理旧消息(按天数)'
    Write-Host '  [3] 清理已撤回消息 + 孤儿文件'
    Write-Host '  [4] 清理孤儿房间'
    Write-Host '  [5] 完全重置数据库(危险)'
    Write-Host '  [0] 退出'
    Write-Host ''
    Write-Host '  注意: 可视化版本已集成到聊天室管理后台'
    Write-Host '  (管理员控制台 → 清理后台)'
    Write-Host ''
}

function Get-MysqlConn {
    Add-Type -Path (Join-Path $ProjectRoot 'node_modules\mysql2\mysql2.js') 2>$null
    # 用 mysql 命令行或直接调 node 脚本
    $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $nodeExe) { $nodeExe = 'C:\Program Files\nodejs\node.exe' }
    return $nodeExe
}

function Invoke-SqlQuery {
    param([string]$sql, [array]$params = @())
    $nodeExe = Get-MysqlConn
    $script = @"
const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection({
    host: '$mysqlHost', port: $mysqlPort,
    user: '$mysqlUser', password: '$mysqlPassword',
    database: '$mysqlDatabase'
  });
  try {
    const [rows] = await conn.query(`$sql`$(if ($params.Count -gt 0) { ', ' + ($params | ForEach-Object { "'" + $_ + "'" }) -join ', ' }));
    console.log(JSON.stringify(rows));
  } finally {
    await conn.end();
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
"@
    $tmpFile = [System.IO.Path]::GetTempFileName() + '.js'
    Set-Content -Path $tmpFile -Value $script -Encoding UTF8
    try {
        $result = & $nodeExe $tmpFile
        if ($LASTEXITCODE -eq 0 -and $result) {
            return $result | ConvertFrom-Json
        }
    } finally {
        Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue
    }
}

function Show-Stats {
    Write-Host '`n正在获取统计信息...' -ForegroundColor Yellow
    $nodeExe = Get-MysqlConn
    $script = @"
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
(async () => {
  const conn = await mysql.createConnection({
    host: '$mysqlHost', port: $mysqlPort,
    user: '$mysqlUser', password: '$mysqlPassword',
    database: '$mysqlDatabase'
  });
  try {
    const [m] = await conn.query('SELECT COUNT(*) AS c FROM messages');
    const [r] = await conn.query('SELECT COUNT(*) AS c FROM messages WHERE revoked=1');
    const [rm] = await conn.query('SELECT COUNT(*) AS c FROM rooms');
    const [g] = await conn.query(`SELECT COUNT(*) AS c FROM messages WHERE scope='group'`);
    const [p] = await conn.query(`SELECT COUNT(*) AS c FROM messages WHERE scope='private'`);
    const [f] = await conn.query(`SELECT COUNT(*) AS c FROM messages WHERE file_url IS NOT NULL AND file_url!=''`);
    const uploads = path.join('$ProjectRoot'.replace(/\\\\/g, '/'), 'public', 'uploads');
    let diskFiles = 0, diskSize = 0;
    try {
      const files = fs.readdirSync(uploads);
      for (const fn of files) {
        try {
          const st = fs.statSync(path.join(uploads, fn));
          if (st.isFile()) { diskFiles++; diskSize += st.size; }
        } catch(e) {}
      }
    } catch(e) {}
    console.log(JSON.stringify({
      messages: m[0].c, revoked: r[0].c, rooms: rm[0].c,
      group_messages: g[0].c, private_messages: p[0].c,
      file_messages: f[0].c, disk_files: diskFiles, disk_size: diskSize
    }));
  } finally {
    await conn.end();
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
"@
    $tmpFile = [System.IO.Path]::GetTempFileName() + '.js'
    Set-Content -Path $tmpFile -Value $script -Encoding UTF8
    try {
        $result = & $nodeExe $tmpFile
        if ($LASTEXITCODE -eq 0 -and $result) {
            $s = $result | ConvertFrom-Json
            Write-Host ''
            Write-Host '======================================' -ForegroundColor Green
            Write-Host '  数据统计' -ForegroundColor Green
            Write-Host '======================================' -ForegroundColor Green
            Write-Host ('  消息总数:    {0}' -f $s.messages)
            Write-Host ('  房间数量:    {0}' -f $s.rooms)
            Write-Host ('  群聊消息:    {0}' -f $s.group_messages)
            Write-Host ('  私聊消息:    {0}' -f $s.private_messages)
            Write-Host ('  已撤回:      {0}' -f $s.revoked)
            Write-Host ('  含文件消息:  {0}' -f $s.file_messages)
            Write-Host ('  磁盘文件数:  {0}' -f $s.disk_files)
            Write-Host ('  磁盘占用:    {0} bytes ({1:N2} MB)' -f $s.disk_size, ($s.disk_size/1024/1024))
            Write-Host '======================================' -ForegroundColor Green
        } else {
            Write-Host '获取统计失败' -ForegroundColor Red
        }
    } finally {
        Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue
    }
}

function Clean-OldMessages {
    $days = Read-Host '`n输入要清理的天数(默认 30)'
    if (-not $days) { $days = '30' }
    $confirm = Read-Host "确定要清理 $days 天前的所有消息吗?(y/N)"
    if ($confirm -ne 'y' -and $confirm -ne 'Y') {
        Write-Host '已取消' -ForegroundColor Yellow
        return
    }
    Write-Host '`n正在清理...' -ForegroundColor Yellow
    $nodeExe = Get-MysqlConn
    $script = @"
const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection({
    host: '$mysqlHost', port: $mysqlPort,
    user: '$mysqlUser', password: '$mysqlPassword',
    database: '$mysqlDatabase'
  });
  try {
    const cutoff = Date.now() - parseInt('$days') * 24 * 60 * 60 * 1000;
    const [res] = await conn.query('DELETE FROM messages WHERE time < ?', [cutoff]);
    console.log('DELETED:' + res.affectedRows);
  } finally { await conn.end(); }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
"@
    $tmpFile = [System.IO.Path]::GetTempFileName() + '.js'
    Set-Content -Path $tmpFile -Value $script -Encoding UTF8
    try {
        $result = & $nodeExe $tmpFile
        if ($result -match 'DELETED:(\d+)') {
            Write-Host ('`n✅ 清理完成:删除 {0} 条消息' -f $matches[1]) -ForegroundColor Green
        }
    } finally {
        Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue
    }
}

function Clean-Revoked {
    $confirm = Read-Host '`n确定要清理所有已撤回的消息和孤儿文件吗?(y/N)'
    if ($confirm -ne 'y' -and $confirm -ne 'Y') {
        Write-Host '已取消' -ForegroundColor Yellow
        return
    }
    Write-Host '`n正在清理...' -ForegroundColor Yellow
    $nodeExe = Get-MysqlConn
    $script = @"
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
(async () => {
  const conn = await mysql.createConnection({
    host: '$mysqlHost', port: $mysqlPort,
    user: '$mysqlUser', password: '$mysqlPassword',
    database: '$mysqlDatabase'
  });
  try {
    const [res] = await conn.query('DELETE FROM messages WHERE revoked=1');
    const uploads = path.join('$ProjectRoot'.replace(/\\\\/g, '/'), 'public', 'uploads');
    // 获取所有被引用的文件
    const [rows] = await conn.query(`SELECT file_url FROM messages WHERE file_url IS NOT NULL AND file_url!=''`);
    const referenced = new Set();
    rows.forEach(r => {
      const m = r.file_url.match(/\\/uploads\\/([^\\/?#]+)/);
      if (m) referenced.add(m[1]);
    });
    // 删除孤儿文件
    let filesDeleted = 0;
    try {
      const files = fs.readdirSync(uploads);
      for (const fn of files) {
        if (!referenced.has(fn)) {
          try {
            const st = fs.statSync(path.join(uploads, fn));
            if (st.isFile()) { fs.unlinkSync(path.join(uploads, fn)); filesDeleted++; }
          } catch(e) {}
        }
      }
    } catch(e) {}
    console.log('MSG:' + res.affectedRows + ',FILE:' + filesDeleted);
  } finally { await conn.end(); }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
"@
    $tmpFile = [System.IO.Path]::GetTempFileName() + '.js'
    Set-Content -Path $tmpFile -Value $script -Encoding UTF8
    try {
        $result = & $nodeExe $tmpFile
        if ($result -match 'MSG:(\d+),FILE:(\d+)') {
            Write-Host ('`n✅ 清理完成:删除 {0} 条撤回消息,{1} 个孤儿文件' -f $matches[1], $matches[2]) -ForegroundColor Green
        }
    } finally {
        Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue
    }
}

function Clean-OrphanRooms {
    $confirm = Read-Host '`n确定要清理所有无房主的孤儿房间吗?(y/N)'
    if ($confirm -ne 'y' -and $confirm -ne 'Y') {
        Write-Host '已取消' -ForegroundColor Yellow
        return
    }
    Write-Host '`n正在清理...' -ForegroundColor Yellow
    $nodeExe = Get-MysqlConn
    $script = @"
const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection({
    host: '$mysqlHost', port: $mysqlPort,
    user: '$mysqlUser', password: '$mysqlPassword',
    database: '$mysqlDatabase'
  });
  try {
    const [rooms] = await conn.query(`SELECT id, name FROM rooms WHERE id!='default' AND (owner IS NULL OR owner='')`);
    let msgCount = 0;
    for (const r of rooms) {
      const [res] = await conn.query('DELETE FROM messages WHERE room_id=?', [r.id]);
      msgCount += res.affectedRows;
      await conn.query('DELETE FROM rooms WHERE id=?', [r.id]);
    }
    console.log('ROOMS:' + rooms.length + ',MSG:' + msgCount);
  } finally { await conn.end(); }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
"@
    $tmpFile = [System.IO.Path]::GetTempFileName() + '.js'
    Set-Content -Path $tmpFile -Value $script -Encoding UTF8
    try {
        $result = & $nodeExe $tmpFile
        if ($result -match 'ROOMS:(\d+),MSG:(\d+)') {
            Write-Host ('`n✅ 清理完成:删除 {0} 个孤儿房间,{1} 条关联消息' -f $matches[1], $matches[2]) -ForegroundColor Green
        }
    } finally {
        Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue
    }
}

function Reset-Database {
    Write-Host '`n⚠ 危险操作!' -ForegroundColor Red
    Write-Host '这将删除所有消息、所有非默认房间、所有上传文件。' -ForegroundColor Red
    $confirm = Read-Host '输入 "我确认重置" 以继续'
    if ($confirm -ne '我确认重置') {
        Write-Host '已取消' -ForegroundColor Yellow
        return
    }
    Write-Host '`n正在重置...' -ForegroundColor Yellow
    $nodeExe = Get-MysqlConn
    $script = @"
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
(async () => {
  const conn = await mysql.createConnection({
    host: '$mysqlHost', port: $mysqlPort,
    user: '$mysqlUser', password: '$mysqlPassword',
    database: '$mysqlDatabase'
  });
  try {
    await conn.query('DELETE FROM messages');
    await conn.query(`DELETE FROM rooms WHERE id!='default'`);
    await conn.query(`UPDATE rooms SET name='公共大厅', password_hash=NULL, owner='admin', is_private=0 WHERE id='default'`);
    // 清空上传目录
    const uploads = path.join('$ProjectRoot'.replace(/\\\\/g, '/'), 'public', 'uploads');
    let filesDeleted = 0;
    try {
      const files = fs.readdirSync(uploads);
      for (const fn of files) {
        try {
          const st = fs.statSync(path.join(uploads, fn));
          if (st.isFile()) { fs.unlinkSync(path.join(uploads, fn)); filesDeleted++; }
        } catch(e) {}
      }
    } catch(e) {}
    console.log('FILES:' + filesDeleted);
  } finally { await conn.end(); }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
"@
    $tmpFile = [System.IO.Path]::GetTempFileName() + '.js'
    Set-Content -Path $tmpFile -Value $script -Encoding UTF8
    try {
        $result = & $nodeExe $tmpFile
        if ($result -match 'FILES:(\d+)') {
            Write-Host ('`n✅ 数据库已重置:删除所有消息和房间(保留公共大厅),{0} 个文件' -f $matches[1]) -ForegroundColor Green
        }
    } finally {
        Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue
    }
}

# 主循环
while ($true) {
    Show-Menu
    $choice = Read-Host '请选择'
    switch ($choice) {
        '1' { Show-Stats }
        '2' { Clean-OldMessages }
        '3' { Clean-Revoked }
        '4' { Clean-OrphanRooms }
        '5' { Reset-Database }
        '0' { exit }
        default { Write-Host '无效选择' -ForegroundColor Red }
    }
    if ($choice -ne '0') {
        Write-Host ''
        Read-Host '按回车继续'
    }
}
