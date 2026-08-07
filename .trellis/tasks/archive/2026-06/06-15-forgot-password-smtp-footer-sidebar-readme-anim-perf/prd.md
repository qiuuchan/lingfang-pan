# 忘记密码/SMTP/邮箱验证/页脚/侧边栏/README/动画/加载优化

## Goal（目标）

9 项完善：忘记密码流程完善 + SMTP 发信完善 + 邮箱验证 + SMTP 测试发信 + 侧边栏不随滚动 + 固定页脚 + README 美化重写 + 加载速度优化 + 应用话术优化+动画。

## 范围（9 项）

### 1-2-3-6. 邮件相关（后端 + 前端）

- **忘记密码完善**：桌面 Auth 已有 forgot/reset UI；admin LoginPage 补忘记密码入口（当前缺）。
- **SMTP 发信完善**：mail.service 已有 nodemailer + console.log 兜底。完善：
  - 生产 SMTP_URL 未配时启动期更明显的告警（非阻塞但醒目）。
  - 邮件模板美化（HTML 邮件，含平台 logo/名称，而非纯文本）。
  - SMTP_FROM 支持（发件人）。
- **邮箱验证（新）**：注册后发验证邮件，User 加 emailVerified 字段。
  - POST /api/auth/verify-email（token 验证）。
  - POST /api/auth/resend-verification。
  - 未验证用户限制（如 7 天后清理，首版只标记不强制阻断登录，提示去验证）。
- **SMTP 测试发信**：admin settings 加「测试发信」按钮 → POST /api/admin/settings/test-email（发测试邮件到指定地址，验证 SMTP 配置正确）。
- **app 和 admin 都加忘记密码**：桌面 Auth 已有；admin LoginPage 补。

### 3. 侧边栏不随页面滚动

- 桌面 Sidebar.tsx + admin sidebar.tsx：滚动页面内容时，侧边栏固定（sticky top-0 或 fixed），不随主内容滚动。
- 当前 nav 区 overflow-y-auto（自身可滚），但整体随页面滚 → 改为 height: 100vh / sticky top-0 / flex 布局让主内容区独立滚动。

### 4. 页脚 + 固定

- 桌面应用加页脚（Footer 组件，固定底部，含版权/版本/链接）。
- admin 后台加页脚（管理端各 View 底部）。
- 页脚固定（sticky bottom 或固定布局，不随内容滚动消失）。

### 7. README 美化重写

- 重新分析项目（架构/特性/技术栈/截图占位/快速开始/部署/贡献指南）。
- 美观 markdown（徽章/表格/目录/emoji 适度）。
- 反映当前完整能力（CLI 注入/模型网关/检查更新/通知/导出等）。

### 8. 加载速度优化

- **admin**：路由懒加载（React.lazy 各 View，减少首屏 bundle）、字体分片已做、图片懒加载、bundle 分析。
- **桌面 app**：vite 代码分割（手动 manualChunks）、懒加载重页面（PluginCreatorHome 等）、预加载关键资源。
- 检查 bundle 体积，优化大依赖。

### 9. 话术优化 + 动画

- 桌面应用部分话术再优化（更友好/准确）。
- 桌面加更多动画（已有 framer-motion？桌面端检查；若无需装）：
  - 页面切换转场、列表入场、卡片悬停、按钮反馈。
  - 加载骨架屏。

## Constraints

- 简体中文。UTF-8 无 BOM。
- 邮箱验证不强制阻断登录（首版只标记+提示，避免锁死用户）。
- SMTP 测试发信要真实发（配了 SMTP_URL）或 console.log（未配），返成功/失败。
- 侧边栏/页脚固定不破坏现有布局。
- README 内容真实（基于当前代码，不夸大）。
- 加载优化不破坏功能（懒加载注意 hydration/路由）。
- 动画用 framer-motion（admin 已装；桌面若无则装）。

## Acceptance Criteria

- [ ] AC1 admin LoginPage 有忘记密码入口，能发起重置。
- [ ] AC2 邮件模板美化（HTML 含平台名），SMTP 配置后能真实发信。
- [ ] AC3 User 加 emailVerified，注册发验证邮件，verify-email 端点工作。
- [ ] AC4 admin settings 有「测试发信」按钮，POST test-email 返发信结果。
- [ ] AC5 滚动主内容时侧边栏不滚动（固定）。
- [ ] AC6 桌面 + admin 有固定页脚。
- [ ] AC7 README 美化重写（完整反映项目，美观）。
- [ ] AC8 admin 路由懒加载 + 桌面代码分割，首屏 bundle 减小。
- [ ] AC9 桌面加更多动画（页面转场/列表/卡片）+ 话术优化。
- [ ] AC10 全量验证绿（typecheck/test/build 不回归）。

## 实施（Workflow 分组并行）

- 组A：邮件相关（后端 mail.service 完善 + 邮箱验证 + 测试发信端点 + 前端 forgot/test-email UI）。
- 组B：侧边栏固定 + 页脚（桌面 + admin 布局）。
- 组C：README 美化重写。
- 组D：加载优化（懒加载/分割）+ 动画话术（桌面）。
