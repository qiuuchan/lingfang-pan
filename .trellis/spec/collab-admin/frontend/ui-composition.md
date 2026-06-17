# collab-admin UI 组合规范

## View Boundaries

后台 view 面向重复管理操作，优先使用密度适中的表格、筛选、Dialog 和表单 section。不要把多个设置域长期塞进一个超大组件。

大型 view 拆分方向：

- `settings-view.tsx`：拆成 platform、SMTP、Geetest、Gitee 等 form section，并提取共享 API hooks。
- `plugins-view.tsx`：拆列表、审核操作、详情 Dialog、状态 badge。
- `releases-view.tsx`：拆 release 列表、asset 上传、发布/归档操作。

## State Placement

- 只被一个 form section 使用的字段放在 section 内。
- 跨 section 的加载、保存、toast 和 reload 放在 view shell 或 hook。
- API payload mapping 放在 `src/lib/` 或本 view 子目录 helper，不要内联在 JSX 深处。

## Settings View Shared Components

When `settings-view.tsx` is just over the 1000-line trigger, first extract real shared controls before splitting stateful form sections. Good low-risk candidates:

- theme option button/card -> `components/settings/SettingsShared.tsx`;
- reveal-secret dialog/button -> `components/settings/SettingsShared.tsx`.

Keep shared components below the function-length limits as well. If a moved component owns a dialog with multiple states, split inner content/footer helpers rather than leaving one long render function.

## File Size Trigger

修改 `1000+` 行 view 时，本次改动必须顺手抽出一个真实职责模块，除非任务文档写明不拆的理由。

Wrong:

```tsx
export function SettingsView() {
  // platform + smtp + captcha + gitee + all dialogs in one body
}
```

Correct:

```tsx
export function SettingsView() {
  return (
    <>
      <PlatformSettingsSection />
      <SmtpSettingsSection />
      <GeetestSettingsSection />
      <GiteeSettingsSection />
    </>
  );
}
```
