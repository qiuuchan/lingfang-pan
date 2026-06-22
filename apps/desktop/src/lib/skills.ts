// skills.ts — Skill 系统（Task 12）。
//
// Skill = 可组合的系统提示词片段（named prompt fragment）。创建器在拼装 systemPrompt 时，
// 基础提示 + 当前激活的 skills 拼接，让「插件创建」「输出精简」「增量重构」等能力模块化、
// 可开关、可扩展（未来新增 skill 只需注册，不改创建器主流程）。
//
// 设计：
// - 每个 skill 自带 id / 名称 / 描述 / prompt 片段。描述供 UI 展示与选择（此处不耦合 UI）。
// - assembleSystemPrompt(base, activeIds) 纯函数拼装，base 为既有完整提示词，skills 追加其上。
// - DEFAULT_ACTIVE_SKILLS：创建插件任务默认激活的 skill 集合（精简输出 + 增量重构）。
//   对应 Task 12「针对创建插件任务，精简和优化大模型的输出格式和内容」。

export interface Skill {
  id: string;
  /** 展示名（供 skill 选择器 UI 用）。 */
  name: string;
  /** 一句话描述该 skill 强化什么能力。 */
  description: string;
  /** 注入到系统提示词的片段（追加在 base 之后）。 */
  prompt: string;
  /** 是否默认激活（创建器开箱即用）。 */
  defaultActive?: boolean;
}

// 精简输出 skill：把「最小化产出」固化为一条强约束，减少 token 浪费与无关文件。
// 与基础提示词的「输出克制」互补——这里更具体地禁止样板/占位/注释类文件。
const OUTPUT_MINIMIZE: Skill = {
  id: 'output-minimize',
  name: '输出精简',
  description: '只产必要文件，禁止样板与占位，降低 token 占用',
  defaultActive: true,
  prompt: `# 输出精简约束
- 产出文件集合 = manifest + 入口文件 + 声明的依赖描述（requirements.txt / package.json）。仅此而已。
- 严禁产出：README、LICENSE、CHANGELOG、注释说明文件、占位 .gitkeep、与需求无关的「额外加分」脚本。
- 一个文件能解决就不拆成多个；一段话能说清就不写一段。
- 回复正文 ≤ 3 句：生成了什么类型、入口是什么、怎么用。不复述文件内容、不解释代码细节。`,
};

// 增量重构 skill：修改已有插件时按「读—改—最小 diff」操作，避免全量重写。
const PLUGIN_REFACTOR: Skill = {
  id: 'plugin-refactor',
  name: '增量重构',
  description: '改已有插件时先读后改、最小 diff，不重写未变文件',
  defaultActive: true,
  prompt: `# 增量重构（修改已有插件）
- 接到「改 / 调整 / 修」类指令时，第一步用 read_file 读取目标文件当前内容，再做最小改动写回。
- 只 write_file 真正变化的文件；未变动的文件不重写、不复制。
- 改动聚焦用户本次明确要求的一点；不顺手「优化」无关代码（避免引入回归）。
- 改完用一句话说明「改了哪个文件的哪一点」，不复述全文。`,
};

// 注册表（未来新增 skill 在此追加，创建器与 UI 自动可见）。
export const SKILLS: Skill[] = [OUTPUT_MINIMIZE, PLUGIN_REFACTOR];

/** 默认激活的 skill id 列表。 */
export const DEFAULT_ACTIVE_SKILLS: string[] = SKILLS
  .filter((s) => s.defaultActive)
  .map((s) => s.id);

const SKILL_BY_ID: Record<string, Skill> = Object.fromEntries(
  SKILLS.map((s) => [s.id, s]),
);

/**
 * 拼装系统提示词：base + 激活的 skills（按注册顺序追加，每个 skill 用分隔线隔开）。
 * 未知 id 静默跳过（容错：UI 删了某 skill 不致整体失败）。
 */
export function assembleSystemPrompt(base: string, activeIds: string[] | readonly string[]): string {
  const fragments: string[] = [];
  for (const id of activeIds) {
    const skill = SKILL_BY_ID[id];
    if (skill) fragments.push(skill.prompt);
  }
  if (fragments.length === 0) return base;
  return `${base}\n\n---\n\n${fragments.join('\n\n---\n\n')}`;
}

/** 取激活 skill 的展示信息（供 UI 列出当前生效的能力）。 */
export function activeSkills(activeIds: string[] | readonly string[]): Skill[] {
  return activeIds
    .map((id) => SKILL_BY_ID[id])
    .filter((s): s is Skill => Boolean(s));
}
