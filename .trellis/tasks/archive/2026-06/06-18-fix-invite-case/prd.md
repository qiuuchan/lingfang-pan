# 修复邀请码大小写不匹配

## Goal

让用户输入的有效邀请码无论大小写都能成功兑换，消除"从未使用却提示邀请码无效"的现象。

## 根因

`apps/collab-api/src/modules/team.service.ts`：

- 第 7 行 `hashInvite = (code) => sha256(code.trim())`：仅去空白，不归一大小写。
- 第 164 行生成：`code = LF-${randomBytes(9).toString('base64url').toUpperCase()}`，先转大写再 `hashInvite`（第 169 行）。
- 因此库中所有 `codeHash` 都是「大写规范形」的哈希。

兑换链路：`Onboarding.tsx:56` → `POST /api/invitations/redeem`（body 已 `code.trim()`）→ `redeemInvitation`（第 45 行）`hashInvite(code)`。用户若以小写或大小写混合输入（复制粘贴串大小写、移动端自动小写），`hashInvite` 算出的哈希与库中大写规范形不一致 → `findUnique` 返回 null → 第 46 行抛"邀请码无效"。该现象与"没用过"一致（不是 `usedCount` 上限路径）。

## 方案

在唯一哈希入口 `hashInvite` 内归一为大写：`sha256(code.trim().toUpperCase())`。

- 生成侧 code 已是大写，归一后哈希值不变 → 存量邀请码完全兼容，无需数据迁移。
- 兑换侧用户任意大小写输入都会归一到与库中一致的规范形。
- 因生成强制 `toUpperCase()`，真实 code 仅含大写字母与数字与 `-`，归一不会引入新碰撞。

## Requirements

- 修改 `hashInvite` 为 `createHash('sha256').update(code.trim().toUpperCase()).digest('hex')`，并加注释说明大小写归一的契约（生成与兑换必须共用同一归一）。
- 不改动 Prisma schema、不做数据迁移、不引入向后兼容包袱。
- 前端可附带把兑换入口输入即时大写显示（可选，非必须，不影响后端正确性）。

## Acceptance Criteria

- [ ] `hashInvite` 对输入做 `trim().toUpperCase()` 归一。
- [ ] 同一邀请码以全小写、全大写、混合大小写输入，`hashInvite` 产出相同哈希（单元测试覆盖）。
- [ ] 现有生成逻辑产出的 codeHash 不变（生成侧已大写，回归确认）。
- [ ] 后端构建通过（`pnpm --filter <collab-api> build` 或等价 `tsc`）。

## Notes

- 后端单点改动 + 单元测试，PRD-only 轻量任务。
- 验证：新增/补充 hashInvite 大小写一致性单测；构建通过。
