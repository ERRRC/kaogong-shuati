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
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > -1 ? path.resolve(process.argv[outIdx + 1]) : path.join(ROOT, 'tiku.db');
const EXPECTED_MD5 = 'efaa2274fc6aa9c385bc30842556b215'; // 2026-09-24 分卷时实测

if (outIdx === -1 && existsSync(OUT)) {
  console.error('tiku.db 已存在，无需重组。如需强制重建，请先手动删除它。');
  process.exit(1);
}

const parts = (await readdir(ROOT))
  .filter((f) => /^tiku\.db\.part-\d+$/.test(f))
  .sort();
if (parts.length === 0) {
  console.error('未找到 tiku.db.part-* 分卷文件。');
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
  console.error(`警告：MD5 不匹配！得到 ${md5}，期望 ${EXPECTED_MD5}。`);
  console.error('分卷可能在下载中损坏，请重新克隆或重跑本脚本前删除 tiku.db。');
  process.exit(2);
}
