# 考公刷题（行测/申论/事业编）—— Web + Android + AI 解析

零依赖 Node.js 后端 + 本地 SQLite 题库的考公刷题全栈应用：模块树刷题、错题本、学习统计，内置可插拔的 AI 智能体（行测方法论解析、申论要点批改、图形推理识图转写、学习建议、题目导入解析）。同一套代码同时服务浏览器端与 Android App（Capacitor）。

> ⚠️ **版权与合规**：题库数据与数据采集工具**不随本仓库分发**（数据版权归粉笔等来源方）。应用读取本地生成的 SQLite 题库（`tiku.db` 等），克隆仓库后需自行准备数据方可刷题。本项目仅供个人学习，请勿商用。

## 功能特性

**刷题**

- 模块树刷题：行测六大模块（政治理论/常识判断/言语理解/数量关系/判断推理/资料分析）知识点树；申论标准五题型树（归纳概括/综合分析/提出对策/贯彻执行/文章写作）；综应/事业编题型树——各节点题量/已做/正确率实时聚合
- 题型覆盖：单选/多选/判断/不定项 + 申论/综应主观题；答题卡质感 UI（Ocean Depths 主题、深浅双模式、移动端优先 + 桌面适配）
- 做题记录服务端落库（`practice.db`，手机/电脑跨设备同步）：错题本、收藏、单题重做、统计概览、近 7 天趋势
- 自定义题库：导入自有题目（文本粘贴/PDF/Excel/图片 OCR），AI 辅助拆分为结构化题目，支持按科目管理

**AI 能力**（五个智能体，OpenAI 兼容协议，各自独立 base_url / api_key / model，改完即生效，提示词带版本历史可回滚）

- **行测解析 AI**：注入速算/解题方法论技能库，按【考点/正确项解析/错误项排除/解题技巧】格式讲解
- **申论批改 AI**：按要点采分制评分，自动提取题干分值，可带给定材料对照评分
- **识图转写员**：多模态视觉模型，图形推理/图表/手写作答图片逐字转写；含图题自动走「识图 → 解析」两段式管线
- **学习进度顾问**：基于真实做题数据输出【总体评估/薄弱环节/趋势分析/下一步行动】
- **题目解析员**：自定义题库导入时把杂乱原文整理为结构化题目
- **技能库可插拔**：AI 设置页导入技能包（SKILL.md + references），按名称自动注入提示词（`ref-skills/` 附开源技能上游副本，见下方致谢）

## 运行

- 环境要求：Node.js ≥ 22.5（使用内置 `node:sqlite`）
- Windows 双击 `启动.bat`（自动打开浏览器），或：

  ```powershell
  node server.mjs 3000
  ```

- 首次运行自动建表；AI 功能需在「AI 设置」页（`http://localhost:3000/?view=ai`）配置 base_url + api_key（DeepSeek/通义/GLM/OpenAI/本地 Ollama 等 OpenAI 兼容网关均可，测试按钮可先试跑）
- 数据文件：`tiku.db`（只读题库）、`practice.db`（做题记录）、`ai-config.db`（AI 配置）均为本地生成，已加入 .gitignore
- Android 打包：`app/` 为 Capacitor 工程，完整构建步骤见 [`BUILD_MANUAL.md`](BUILD_MANUAL.md)（含第三方构建者的 Debug 包路线）

## 目录结构

```
├── server.mjs                 # 零依赖后端（静态服务 + 刷题/记录/AI 接口）
├── public/                    # Web 前端（App 端共享逻辑；vendor/ 为第三方库分发包）
├── lib/
│   ├── ai-agents.mjs          # AI 智能体配置与调用（技能注入/网关调用/热更新）
│   ├── fenbi-tree.mjs         # 行测知识点树 + 申论/综应题型树
│   ├── xingce-chapter-map.mjs # 真题章节 → 树节点映射
│   ├── pdf-ocr.mjs            # 申论材料 PDF 视觉 OCR（可选）
│   └── local-queries.mjs      # App 端本地查询
├── app/                       # Capacitor Android 工程
├── ref-skills/                # 开源考公技能上游副本（仅参考，运行时从本地技能库加载）
├── docs/                      # 设计与技术文档
└── 启动.bat                   # Windows 一键启动
```

## 第三方开源组件致谢

本仓库 `ref-skills/` 目录包含以下开源考公技能项目的完整副本（仅作本地学习与 AI 方法论注入参考），版权归原作者所有，本项目非商用：

| 项目 | 许可证 | 用途 |
|---|---|---|
| [shenlun-review-pro](https://github.com/liuyuexi1987/shenlun-review-pro) | GPL-3.0（副本内附 LICENSE 原文） | 申论批改/复盘方法论 |
| Shenlun.skill | MIT | 申论备考训练 |
| huasheng13-skill（作者 [WangJunqing-coder](https://github.com/WangJunqing-coder)） | MIT | 行测速算与解题方法论 |
| daily-gongkao-skill | 上游未声明许可证，版权归原作者所有 | 公考日常学习参考 |

说明：技能内容运行时从本地技能库加载（`ai-config.db` 的 user_skills 表），`ref-skills/` 仅为上游参考副本，软件功能不依赖该目录存在。`public/vendor/` 为开源库本地分发包：pdf.js（Apache-2.0）、SheetJS（Apache-2.0）、sql.js（MIT）。如上游作者对再分发有异议，请提 issue 联系移除。

## 参考

- 申论/综应题库数据（Markdown，4886 题）：https://github.com/2421873411a-rgb/gongkao-tiku
