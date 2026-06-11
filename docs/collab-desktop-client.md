# 本地客户端接入说明

本地客户端 `apps/desktop` 是协作平台前台，服务普通用户和团队管理员。

## 后端地址

首次启动需要填写统一 API 地址，例如：

```text
http://127.0.0.1:3000
```

客户端会访问 `/api/health` 做健康检查。

## 页面状态

后端 `/api/auth/me` 和 `/api/me/onboarding` 返回 onboarding 状态：

- `NEEDS_INVITATION`：显示邀请码输入页。
- `PENDING_APPROVAL`：显示团队管理员申请待审批页。
- `APPLICATION_REJECTED`：显示驳回原因。
- `TEAM_SPACE`：进入团队空间首页。
- `TEAM_ADMIN_SPACE`：进入团队管理。
- `PLATFORM_ADMIN_WEB_ONLY`：提示平台管理员使用网页管理端。

## 团队管理员能力

团队管理员只能在本团队内：

- 查看成员。
- 移除普通成员。
- 生成/禁用邀请码。
- 查看团队余额和流水。

不能：

- 修改团队余额。
- 管理其他团队。
- 启用/禁用平台插件。
- 处理审批。

## 插件入口

客户端通过 `/api/plugins/available` 获取可用插件。平台管理员禁用的插件不会返回。