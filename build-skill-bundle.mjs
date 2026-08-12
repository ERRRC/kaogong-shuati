// 一次性脚本：把本地 skill 打包为 public/app-assets/skill-<name>.json
// 供本地模式（浏览器/手机，无文件系统）自动注入 skill 内容使用
// 用法：node build-skill-bundle.mjs [skill名...]（默认打包全部已配置 skill）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(__dirname, '../.reasonix/skills');
const OUT_DIR = path.join(__dirname, 'public/app-assets');
const ALL = ['gongkao-huasheng13', 'shenlun-master'];
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ALL;

for (const name of targets) {
  const skillDir = path.join(SKILLS_ROOT, name);
  if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
    console.error(`✗ skill 不存在: ${name}（期望 ${skillDir}）`);
    continue;
  }
  const parts = [`===== Skill: ${name}（自动注入） =====`];
  parts.push('[SKILL.md]\n' + fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'));
  let files = 1;
  const refsDir = path.join(skillDir, 'references');
  if (fs.existsSync(refsDir)) {
    for (const f of fs.readdirSync(refsDir).filter((x) => x.endsWith('.md')).sort()) {
      parts.push(`\n----- references/${f} -----\n` + fs.readFileSync(path.join(refsDir, f), 'utf8'));
      files++;
    }
  }
  parts.push('===== Skill 结束 =====');
  const text = parts.join('\n');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `skill-${name}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ name, files, text }));
  console.log(`✓ ${outFile} (${(fs.statSync(outFile).size / 1024).toFixed(1)} KB, ${files} files)`);
}
