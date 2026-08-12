// build-ai-agents.mjs — 把 lib/ai-agents.mjs 的 DEFAULT_AGENTS 导出为浏览器可加载的 JSON
// 用法：node build-ai-agents.mjs
// 输出：public/ai-agents.default.json（App 本地模式下 AI 设置页的默认智能体配置）
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_AGENTS } from './lib/ai-agents.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'public', 'ai-agents.default.json');
// api_key 策略：识图转写员(4)/综应申论文字提取员(5) 为免费模型（智谱 GLM-4.1V-Thinking-Flash），
// key 随安装包分发（用户明确要求，开箱即用）；其余智能体的 key 一律留空（由用户在设置页填写，存本机）
const agents = DEFAULT_AGENTS.map((a) => ({ ...a, api_key: a.id === 4 || a.id === 5 ? a.api_key : '' }));
writeFileSync(out, JSON.stringify(agents, null, 2) + '\n', 'utf8');
console.log(`已生成 ${out}（${agents.length} 个智能体）`);
