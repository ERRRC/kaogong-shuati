#!/usr/bin/env node
// 生成 tiku-index.db：把 practice.db 里的三张「纯派生、无用户数据」的表导出成随仓库分发的索引库。
//
// 背景：question_categories / q_material_map / q_materials 常年只存在于本机的 practice.db，
// 由 build-category-index.mjs（分类索引）与 fetch-materials.mjs（拉材料，需粉笔接口）灌出，
// 两者都不随仓库分发 → 克隆者必报 "no such table question_categories"。
// 本脚本把它们快照到 tiku-index.db（随 git 分发），server.mjs 启动时检测到 practice.db 缺表会自动灌入。
//
//   node tools/build-index-db.mjs
//
// 只在维护者机器上跑（改了分类逻辑或材料数据之后）。

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pdb = new DatabaseSync(path.join(ROOT, 'practice.db'), { readOnly: true });
const OUT = path.join(ROOT, 'tiku-index.db');

if (fs.existsSync(OUT)) fs.rmSync(OUT);
const idx = new DatabaseSync(OUT);

idx.exec('PRAGMA journal_mode = DELETE'); // 避免 -wal 副产物进 git
idx.exec(`
  CREATE TABLE question_categories (
    question_id INTEGER NOT NULL,
    subject TEXT NOT NULL,
    category TEXT NOT NULL,
    sub TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (question_id, subject)
  );
  CREATE INDEX idx_qc_category ON question_categories(category, sub);
  CREATE TABLE q_materials (
    material_id INTEGER NOT NULL,
    subject TEXT NOT NULL,
    content TEXT,
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (material_id, subject)
  );
  CREATE TABLE q_material_map (
    question_id INTEGER NOT NULL,
    subject TEXT NOT NULL,
    material_id INTEGER,
    PRIMARY KEY (question_id, subject)
  );
`);

idx.exec('BEGIN');
for (const t of ['question_categories', 'q_materials', 'q_material_map']) {
  const rows = pdb.prepare(`SELECT * FROM ${t}`).all();
  const cols = Object.keys(rows[0] || {});
  const ins = idx.prepare(
    `INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  );
  for (const r of rows) ins.run(...cols.map((c) => r[c]));
  console.log(`${t}: ${rows.length} 行`);
}
idx.exec('COMMIT');
idx.close();
pdb.close();

const mb = (fs.statSync(OUT).size / 1048576).toFixed(1);
console.log(`完成：tiku-index.db ${mb} MB。请随 git 分发（>90MB 时需分卷）。`);
