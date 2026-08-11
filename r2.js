// Cloudflare R2 存储模块(S3 兼容 API)
// 用途:将上传的文件存到 R2,替代本地 uploads/ 目录
// 配置:在 .env 中设置 R2_* 环境变量,未配置时自动 fallback 到本地存储
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

let s3Client = null;
let bucketName = null;
let publicUrl = null;

// 初始化 R2 客户端(在 server.js 启动时调用)
// 返回 true 表示 R2 已启用,false 表示未配置(用本地存储)
function initR2() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME;
  const url = process.env.R2_PUBLIC_URL;

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !url) {
    console.log('[R2] 未配置 R2 环境变量,上传文件将存到本地 uploads/ 目录');
    return false;
  }

  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  bucketName = bucket;
  publicUrl = url.replace(/\/$/, ''); // 去掉末尾斜杠

  console.log(`[R2] 已启用,bucket: ${bucketName},公共 URL: ${publicUrl}`);
  return true;
}

// 上传文件到 R2
// key: 对象键(如 "1786356082075-9412dad620ab.png")
// body: 文件内容(Buffer)
// contentType: MIME 类型
// 返回: 公共访问 URL
async function uploadToR2(key, body, contentType) {
  if (!s3Client) throw new Error('R2 未初始化');
  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
  }));
  return `${publicUrl}/${key}`;
}

// 删除 R2 中的文件(用于撤回消息时清理)
async function deleteFromR2(key) {
  if (!s3Client) return;
  try {
    await s3Client.send(new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    }));
  } catch (e) {
    // 删除失败不阻塞主流程
    console.error('[R2] 删除失败:', e.message);
  }
}

function isR2Enabled() {
  return s3Client !== null;
}

module.exports = { initR2, uploadToR2, deleteFromR2, isR2Enabled };
