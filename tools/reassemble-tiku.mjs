#!/usr/bin/env node
// 重组 tiku.db：仓库里题库被切成 <95MB 分卷（tiku.db.part-00 ...）以绕过
// GitHub 单文件 100MB 硬限制。克隆后运行本脚本一次即可还原完整题库：
//
//   node tools/reassemble-tiku.mjs            # 重组到 tiku.db
//   node tools/reassemble-tiku.mjs --out X    # 重组到指定路径（自检用）
//
// 零依赖，Node ≥ 18。自带 MD5 自校验。

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > -1 ? path.resolve(process.argv[outIdx + 1]) : path.join(ROOT, 'tiku.db');
const EXPECTED_PARTS = 4; // 2026-09-24 分卷：part-00..03
const EXPECTED_MD5 = 'efaa2274fc6aa9c385bc30842556b215'; // 2026-09-24 分卷时实测

if (outIdx === -1 && existsSync(OUT)) {
  console.error('tiku.db 已存在，无需重组。如需强制重建，请先手动删除它。');
  process.exit(1);
}

const parts = (await readdir(ROOT))
  .filter((f) => /^tiku\.db\.part-\d+$/.test(f))
  .sort();
if (parts.length === 0) {
  console.error('未找到 tiku.db.part-* 分卷文件。请确认已完整克隆本仓库（git clone，勿用第三方下载工具）。');
  process.exit(1);
}
if (parts.length !== EXPECTED_PARTS) {
  console.error(`分卷数量不对：找到 ${parts.length} 个（${parts.join(', ')}），应为 ${EXPECTED_PARTS} 个。`);
  console.error('你的克隆/下载不完整，残缺分卷会拼出损坏的题库。请删除本地仓库后重新 git clone。');
  process.exit(1);
}

console.log(`发现 ${parts.length} 个分卷，开始重组...`);
const hash = createHash('md5');
const out = createWriteStream(OUT);

for (const p of parts) {
  await new Promise((resolve, reject) => {
    const rs = createReadStream(path.join(ROOT, p));
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('error', reject);
    rs.pipe(out, { end: false });
    rs.on('end', resolve);
  });
  console.log(`  已合并 ${p}`);
}

await new Promise((resolve, reject) => {
  out.on('error', reject);
  out.end(resolve);
});

const md5 = hash.digest('hex');
if (md5 === EXPECTED_MD5) {
  console.log(`完成：tiku.db 重组成功，MD5 校验通过（${md5}）`);
} else {
  // 残缺的 tiku.db 会以 "no such table" 之类的错坑人，必须删掉而不是留在磁盘上
  await rm(OUT, { force: true });
  console.error(`MD5 不匹配！得到 ${md5}，期望 ${EXPECTED_MD5}。`);
  console.error('已删除重组出的损坏文件。分卷可能在下载中损坏：请重新 git clone 后重跑本脚本。');
  process.exit(2);
}
