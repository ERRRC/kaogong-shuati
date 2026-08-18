// skill-importer.mjs — 技能包导入解析（无 DOM 依赖，Web/App 共用）
// 支持三种来源：SKILL.md 文本（粘贴/单文件）、zip 压缩包（SKILL.md + references/*.md）、URL（按扩展名/内容判定）
// 与 lib/ai-agents.mjs 的 resolveSkill 包裹格式保持一致（===== Skill: X ===== 分隔），
// 导入后存为拼接全文，注入时直接作为第二条 system 消息。

import { zipEntries } from './custom-parser.js';

const MAX_TEXT = 2 * 1024 * 1024; // 技能内容上限 2MB

/** 提取 YAML frontmatter（--- 开头/结尾，key: value，支持引号与缩进续行） */
export function extractFrontmatter(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { name: '', description: '', body: text.trim() };
  const meta = {};
  let key = '';
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) {
      key = kv[1];
      meta[key] = kv[2].trim().replace(/^['"]|['"]$/g, '');
    } else if (key && line.trim()) {
      meta[key] += ' ' + line.trim(); // 多行描述的续行
    }
  }
  return {
    name: String(meta.name || '').trim(),
    description: String(meta.description || '').trim(),
    body: text.slice(m[0].length).trim(),
  };
}

/** 拼接为与 resolveSkill 一致的包裹格式（references 按路径排序） */
export function composeSkillText(name, mainText, refs = []) {
  const parts = [`===== Skill: ${name}（用户导入） =====`, '[SKILL.md]\n' + String(mainText || '').trim()];
  for (const r of refs) parts.push(`\n----- ${r.path} -----\n` + String(r.text || '').trim());
  parts.push('===== Skill 结束 =====');
  return parts.join('\n');
}

/** 解析 SKILL.md 文本（含 frontmatter 或无 frontmatter；缺 name 用 fallbackName）
 *  返回 { name, description, text（已拼接）, body（原始正文，改名时重拼用） } */
export function parseSkillText(raw, fallbackName = '') {
  const { name, description, body } = extractFrontmatter(raw);
  const n = (name || String(fallbackName || '').trim() || 'my-skill').trim();
  return { name: n, description, body, text: composeSkillText(n, body, []) };
}

/**
 * 解析 zip 技能包（Claude/OpenClaw 风格：SKILL.md + references/*.md）：
 *  - 找 SKILL.md（根目录优先，其次任意路径）
 *  - 技能名：SKILL.md frontmatter 的 name 优先，其次 zip 顶层目录名
 *  - references/ 下**任意层级**的 .md 与 .json 全收（契约/方法库/权重配置都在子目录里），
 *    排除 examples/ 与 README（练习题/说明不注入）
 */
export async function parseSkillZip(buf) {
  const entries = await zipEntries(buf);
  if (!entries.length) throw new Error('zip 为空或不是有效压缩包');
  const rootSkill = entries.find((e) => /^SKILL\.md$/i.test(e.name));
  const skillEntry = rootSkill || entries.find((e) => /(^|\/)SKILL\.md$/i.test(e.name));
  if (!skillEntry) throw new Error('压缩包内未找到 SKILL.md（技能包格式：SKILL.md + references/*.md）');

  const { name: fmName, description, body } = extractFrontmatter(skillEntry.decoded);
  const topDir = skillEntry.name.split('/').length > 1 ? skillEntry.name.split('/')[0] : '';
  const name = (fmName || topDir || 'my-skill').trim();

  const refs = entries
    .filter((e) => /(^|\/)references\/.+\.(md|json)$/i.test(e.name) && !/examples\//i.test(e.name) && !/README/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const refList = refs.map((r) => ({ path: r.name, text: r.decoded }));

  const files = [{ path: skillEntry.name, size: body.length }];
  for (const r of refs) files.push({ path: r.name, size: r.decoded.length });

  const text = composeSkillText(name, body, refList);
  return { name, description, body, text, files, refs: refList };
}

/** 按 URL 扩展名判定技能包类型：zip | text | null（无法判定） */
export function detectSkillUrlKind(url) {
  const clean = String(url || '').split('?')[0].split('#')[0].toLowerCase();
  if (/\.zip$/.test(clean)) return 'zip';
  if (/\.(md|markdown|txt)$/.test(clean)) return 'text';
  return null;
}

/** 按内容头部字节判定：zip 魔数 PK（0x504B）→ zip，否则按文本 */
export function kindFromBytes(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'zip';
  return 'text';
}

/** base64 → Uint8Array（浏览器 atob；Node 侧自动退化） */
export function base64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(String(b64), 'base64'));
  try {
    const bin = atob(String(b64));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}

/** 技能内容校验（与两端存储共用） */
export function validateSkill({ name, text } = {}) {
  const n = String(name || '').trim();
  const t = String(text || '').trim();
  if (!n) return { ok: false, error: '技能名不能为空' };
  if (n.length > 100) return { ok: false, error: '技能名过长（≤100 字符）' };
  if (!t) return { ok: false, error: '技能内容不能为空' };
  if (t.length > MAX_TEXT) return { ok: false, error: '技能内容过大（>2MB），请精简后重试' };
  return { ok: true };
}
