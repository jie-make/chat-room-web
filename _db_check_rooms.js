// 排查房间异常关闭: 查询最近创建的房间的 idle_timeout_hours / empty_since
const { pool } = (() => {
  require('dotenv').config();
  const mysql = require('mysql2/promise');
  const p = mysql.createPool({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'chat_db',
    waitForConnections: true, connectionLimit: 5
  });
  return { pool: p };
})();

(async () => {
  const [rows] = await pool.query(
    `SELECT id, name, owner, is_private, idle_timeout_hours, empty_since, created_at
     FROM rooms ORDER BY created_at DESC LIMIT 8`);
  console.log('最近房间:');
  rows.forEach(r => {
    console.log(`  ${r.id} | ${r.name} | owner=${r.owner} | priv=${r.is_private} | idle_h=${r.idle_timeout_hours} | empty_since=${r.empty_since} | created=${r.created_at}`);
  });
  const [all] = await pool.query(
    `SELECT COUNT(*) AS c FROM rooms WHERE idle_timeout_hours IS NOT NULL AND empty_since IS NOT NULL`);
  console.log('\n配置了空闲超时且已标记为空的房间数:', all[0].c);
  process.exit(0);
})();
