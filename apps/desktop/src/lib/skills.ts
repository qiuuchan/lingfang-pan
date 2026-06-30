// skills.ts — Skill 系统（Task 12）。
//
// Skill = 可组合的系统提示词片段（named prompt fragment）。创建器在拼装 systemPrompt 时，
// 基础提示 + 当前激活的 skills 拼接，让「插件创建」「输出精简」「增量重构」等能力模块化、
// 可开关、可扩展（未来新增 skill 只需注册，不改创建器主流程）。
//
// 设计：
// - 每个 skill 自带 id / 名称 / 描述 / prompt 片段。描述供 UI 展示与选择（此处不耦合 UI）。
// - assembleSystemPrompt(base, activeIds) 纯函数拼装，base 为既有完整提示词，skills 追加其上。
// - DEFAULT_ACTIVE_SKILLS：创建插件任务默认激活的 skill 集合（精简输出 + Qt6 GUI + 增量重构）。
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
  name: '精简产出',
  description: '只生成必要文件，不产生多余说明或占位文件',
  defaultActive: true,
  prompt: `# 输出精简约束
- 产出文件集合 = manifest + 入口文件 + 声明的依赖描述（requirements.txt / package.json）。仅此而已。
- 严禁产出：README、LICENSE、CHANGELOG、注释说明文件、占位 .gitkeep、与需求无关的「额外加分」脚本。
- 一个文件能解决就不拆成多个；一段话能说清就不写一段。
- 回复正文 ≤ 3 句：生成了什么类型、入口是什么、怎么用。不复述文件内容、不解释代码细节。

# CreatePlugin 前自检清单（务必逐项核对，缺一不可）
1. entry 必须真实存在于 files 数组中（路径完全一致），不是只写在 manifest 字段里。
2. 按 runtime_type 补齐必需文件：
   - client → entry=ui/index.html（HTML 内联 CSS/JS）。
   - nodejs → entry=index.js，且 files 必含 package.json（无依赖时 dependencies 用 {}）。
   - python → entry=main.py，且 files 必含 requirements.txt（无依赖时留空文件）。
3. 所有文件路径为相对路径，禁绝对路径/空段/../、禁隐藏段（. 开头）。
4. **CreatePlugin 只传最小骨架**：files 里每个文件只放占位骨架（导入 + 空主函数），**绝不放完整源码**。单文件超 60 行、或含模板字符串/正则/大量引号反斜杠时尤其要这样做——一次性塞进 CreatePlugin 会让 JSON 参数过长被截断或转义出错，工具必然失败。CreatePlugin 成功后再用 Write 逐个文件补完整内容。

# 工具失败必须补齐重试
- CreatePlugin 或 Check 返回错误时，**必须**先读懂错误指出的缺漏，补齐对应文件或改正 entry/命名后重新调用工具，直到成功才算完成。
- 绝不在 CreatePlugin 失败后就向用户报「已生成」——那是未完成状态，用户会拿到跑不起来的破损插件。`,
};

// 增量重构 skill：修改已有插件时按「读—改—最小 diff」操作，避免全量重写。
const PLUGIN_REFACTOR: Skill = {
  id: 'plugin-refactor',
  name: '稳妥改动',
  description: '修改已有插件时只动需要改的部分，不重写其余文件',
  defaultActive: true,
  prompt: `# 增量重构（修改已有插件）
- 接到「改 / 调整 / 修」类指令时，第一步用 Read 读取目标文件当前内容，再做最小改动写回。
- 只用 Edit/Write 写真正变化的文件；未变动的文件不重写、不复制。
- 改动聚焦用户本次明确要求的一点；不顺手「优化」无关代码（避免引入回归）。
- 改完用一句话说明「改了哪个文件的哪一点」，不复述全文。`,
};

// 灵坊平台 AI 接入 skill：把中转 API 文档作为 skill 注入。
// 这是「是否调用该 skill 的判断依据」——当生成的插件需要 AI 能力时，AI 据此 skill 知道
// 必须且仅能调用灵坊平台 relay（sdk.llm.chat / sdk.image.generate），禁第三方接口。
const RELAY_ACCESS: Skill = {
  id: 'relay-access',
  name: '智能能力',
  description: '插件需要 AI 能力时，自动接入平台统一的 AI 服务',
  defaultActive: true,
  prompt: `# 灵坊平台 AI 接入（需求约束）
凡涉及 AI 对话/生图等 AI 能力的插件，**必须且仅能**调用灵坊平台提供的服务，禁止任何第三方或自定义接口。
插件代码里用 @lingfang/plugin-sdk：
- 对话：\`const reply = await sdk.llm.chat({ messages: [{role:'user', content:'...'}], model: 'fast' | 'premium' })\`
  · model 仅 'fast'（快速版）或 'premium'（高级版），底层模型由平台统一配置，不要写死模型 id。
- 生图：\`const { images } = await sdk.image.generate({ prompt: '...', model: 'premium' })\` 返回图片 url/base64 数组。
- 这两个能力经平台中转计费（按团队灵石），插件无需也不可持有任何 API Key 或直连上游。
插件 capabilities 需声明 { kind: 'llm.chat' } / { kind: 'image.generate' }。`,
};

// Python Qt6 GUI skill：把“带界面的 Python 插件”默认收敛到 PySide6 / Qt6，
// 避免模型继续退回 tkinter 或误判成 client iframe。
const PYTHON_QT6_GUI: Skill = {
  id: 'python-qt6-gui',
  name: 'Qt6 界面',
  description: 'Python 带界面插件默认使用 PySide6 / Qt6 桌面窗口',
  defaultActive: true,
  prompt: `# Python Qt6 GUI 默认策略
- 用户提到“带界面 / 窗口 / 桌面 GUI”的 Python 插件时，默认生成 runtime_type=python，entry=main.py，requirements.txt 必含 PySide6。
- GUI 框架默认 PySide6 / Qt6：代码从 PySide6.QtWidgets 导入 QApplication、QWidget 或 QMainWindow，main.py 直接创建 QApplication 并 show 主窗口。
- 用户明确要求 PyQt6 时才用 PyQt6；requirements.txt 对应写 PyQt6。
- tkinter 只作为“无额外依赖 / 极简内置库”兜底，不能再作为默认 GUI 方案。
- 不要把 Python GUI 需求改成 client/HTML，也不要追问窗口显示位置；Python GUI 就是独立桌面窗口。`,
};

// 界面美化 skill：让生成的插件 UI 更精致、与平台风格一致。默认不激活（按需开启）。
const UI_POLISH: Skill = {
  id: 'ui-polish',
  name: '界面美化',
  description: '让插件界面更精致，配色与圆角贴合平台风格',
  prompt: `# 界面美化
- 插件 UI 优先使用平台注入的设计变量：颜色用 var(--lf-color-*)、圆角用 var(--lf-radius-md)、间距用 var(--lf-spacing-md)、字体用 var(--lf-font-sans)，不要硬编码色值。
- 布局留白均匀、对齐统一；交互元素有 hover/active 反馈；避免拥挤与突兀的纯黑/纯白色块。
- 不为美化引入额外的大型 UI 框架或图片资源，用原生 CSS 即可。`,
};

// 健壮性 skill：对输入与异常做基础防御，避免插件一遇到边界情况就崩。默认不激活。
const ROBUSTNESS: Skill = {
  id: 'robustness',
  name: '健壮可靠',
  description: '对空值、异常输入和失败做基础处理，避免插件崩溃',
  prompt: `# 健壮可靠
- 对用户输入做基础校验（空值、类型、范围），给出友好提示而非直接报错。
- 对可能失败的操作（网络、解析、AI 调用）包 try/catch，失败时展示可读的错误信息并保持界面可用。
- 不吞掉错误：捕获后要么提示用户、要么有兜底行为，不要静默失败。`,
};

// 中文优先 skill：界面文案与提示全程简体中文，面向非技术用户。默认不激活。
const CHINESE_FIRST: Skill = {
  id: 'chinese-first',
  name: '中文优先',
  description: '插件界面文案全程简体中文，面向普通用户',
  prompt: `# 中文优先
- 插件所有面向用户的文案（标题、按钮、提示、错误信息）一律用简体中文。
- 用词通俗，避免技术术语；必要的英文专有名词保留即可。
- 日期、数字、金额按中文习惯展示。`,
};

// 移动适配 skill：让插件在窄屏/触摸下也可用。默认不激活。
const MOBILE_READY: Skill = {
  id: 'mobile-ready',
  name: '移动适配',
  description: '让插件在窄屏和触摸操作下也能正常使用',
  prompt: `# 移动适配
- 布局用弹性/自适应（flex/grid + 百分比/最小宽度），窄屏下不溢出、不横向滚动。
- 可点击元素留足触摸区域（建议 ≥ 40px），间距适当放大。
- 避免依赖 hover 才能触发的关键操作，触摸设备上要有等效入口。`,
};

// 注册表（未来新增 skill 在此追加，创建器与 UI 自动可见）。
export const SKILLS: Skill[] = [
  OUTPUT_MINIMIZE,
  PLUGIN_REFACTOR,
  RELAY_ACCESS,
  PYTHON_QT6_GUI,
  UI_POLISH,
  ROBUSTNESS,
  CHINESE_FIRST,
  MOBILE_READY,
];

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
