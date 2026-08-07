# 团队指定默认池子并在调用日志显示池子信息 - PRD

## 概述

允许团队在管理页面指定默认使用的资源池，并在调用日志中显示使用的池子信息。

## 背景

当前系统支持多个资源池（Pool），每个池可以包含多个渠道（Channel）。但是：

- **问题1**：团队无法指定默认使用哪个池子
- **问题2**：调用日志看不出使用的是哪个池子
- **场景**：一个公司有两个池子（如"默认池"和"高级池"），需要在团队管理中选择使用哪个

## 当前数据结构

### Pool 模型

```prisma
model Pool {
  id          String    @id @default(uuid())
  name        String    @unique
  scope       PoolScope @default(SHARED)  // SHARED / DEDICATED
  teamId      String?   // DEDICATED 时指定团队
  description String    @default("")
  createdAt   DateTime  @default(now())
  team        Team?     @relation(fields: [teamId], references: [id])
  channels    Channel[]
}
```

### Team 模型

```prisma
model Team {
  id       String @id @default(uuid())
  name     String
  pools    Pool[] // 关联的专用池
  callLogs LlmCallLog[]
  // ... 其他字段
}
```

### LlmCallLog 模型

```prisma
model LlmCallLog {
  id        String   @id @default(uuid())
  teamId    String
  channelId String?  // 使用的渠道
  channel   Channel? @relation(fields: [channelId], references: [id])
  // ... 其他字段
}
```

### Channel 模型

```prisma
model Channel {
  id     String @id @default(uuid())
  poolId String
  pool   Pool   @relation(fields: [poolId], references: [id])
  // ... 其他字段
}
```

## 需求

### R1: 数据库 Schema 改动

**Team 表新增字段**：

```prisma
model Team {
  // ... 现有字段
  defaultPoolId String? // 团队默认池子 ID
  defaultPool   Pool?   @relation("TeamDefaultPool", fields: [defaultPoolId], references: [id])
}
```

**注意事项**：

- `defaultPoolId` 可为空（兼容现有团队）
- 为空时使用 SHARED 池子（现有逻辑）
- 需要创建数据库迁移

### R2: 后端 API 改动

#### 2.1 团队设置接口（`team.controller.ts`）

**新增/修改接口**：

```typescript
// PATCH /api/teams/:teamId/settings
// 权限：TEAM_ADMIN
{
  defaultPoolId?: string | null  // 设置默认池子
}
```

**业务逻辑**：

- 验证 `defaultPoolId` 存在且团队有权使用
  - SHARED 池：所有团队可用
  - DEDICATED 池：仅 `teamId` 匹配的团队可用
- 允许设置为 `null`（清除默认池，回退到 SHARED 池）

#### 2.2 调用日志查询优化（`billing.controller.ts` 或类似）

**返回字段增强**：

```typescript
interface LlmCallLogDto {
  // ... 现有字段
  poolName?: string; // 通过 channel.pool.name 关联查询
  poolId?: string; // 池子 ID
}
```

**查询优化**：

```typescript
// Prisma 查询需要 include pool
prisma.llmCallLog.findMany({
  include: {
    channel: {
      include: {
        pool: true, // 包含池子信息
      },
    },
  },
});
```

### R3: 前端改动

#### 3.1 团队管理页（`TeamAdmin.tsx`）

**新增"资源池"设置区域**：

位置：团队设置 Tab 中，在成员管理或其他设置附近

UI 组件：

```tsx
<div className="space-y-4">
  <div>
    <h3 className="text-sm font-medium">默认资源池</h3>
    <p className="text-xs text-muted-foreground">选择团队默认使用的资源池。为空时使用共享池。</p>
  </div>

  <Select value={team.defaultPoolId || 'null'} onValueChange={handlePoolChange}>
    <SelectTrigger className="w-64">
      <SelectValue placeholder="使用共享池" />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="null">使用共享池（默认）</SelectItem>
      {availablePools.map((pool) => (
        <SelectItem key={pool.id} value={pool.id}>
          {pool.name}
          {pool.scope === 'DEDICATED' && ' (专用)'}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
</div>
```

**获取可用池子列表**：

```typescript
// 新增 API: GET /api/pools/available
// 返回当前团队可用的池子（SHARED + 本团队的 DEDICATED）
```

#### 3.2 调用日志页面

**表格新增"池子"列**：

位置：在现有的"模型"、"Token"等列之后

```tsx
<TableHead>池子</TableHead>
// ...
<TableCell>
  {log.poolName ? (
    <Badge variant="outline" className="font-mono text-xs">
      {log.poolName}
    </Badge>
  ) : (
    <span className="text-muted-foreground">-</span>
  )}
</TableCell>
```

**筛选器（可选）**：

```tsx
<Select value={poolFilter} onValueChange={setPoolFilter}>
  <SelectTrigger className="w-36">
    <SelectValue />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="ALL">全部池子</SelectItem>
    {pools.map((pool) => (
      <SelectItem key={pool.id} value={pool.id}>
        {pool.name}
      </SelectItem>
    ))}
  </SelectContent>
</Select>
```

### R4: Relay 逻辑调整（可选）

如果需要 Relay 中转时优先使用团队默认池：

**位置**：`apps/collab-api/src/modules/relay/relay.service.ts`

**逻辑**：

1. 获取当前团队的 `defaultPoolId`
2. 如果设置了默认池，优先从该池的渠道中选择
3. 如果默认池无可用渠道，fallback 到 SHARED 池

```typescript
async pickChannel(teamId: string, kind: ChannelKind, tier: ModelTierId) {
  const team = await this.prisma.team.findUnique({
    where: { id: teamId },
    select: { defaultPoolId: true }
  });

  // 优先使用默认池
  if (team.defaultPoolId) {
    const channels = await this.findChannels({
      poolId: team.defaultPoolId,
      kind,
      tier,
      status: 'ENABLED'
    });
    if (channels.length > 0) {
      return this.selectChannel(channels); // 轮询逻辑
    }
  }

  // Fallback 到共享池
  return this.pickFromSharedPools(kind, tier);
}
```

## 数据库迁移

### Migration SQL

```sql
-- 1. 添加 defaultPoolId 列到 Team 表
ALTER TABLE "Team" ADD COLUMN "defaultPoolId" TEXT;

-- 2. 添加外键约束
ALTER TABLE "Team" ADD CONSTRAINT "Team_defaultPoolId_fkey"
  FOREIGN KEY ("defaultPoolId")
  REFERENCES "Pool"("id")
  ON DELETE SET NULL;

-- 3. 添加索引（提升查询性能）
CREATE INDEX "Team_defaultPoolId_idx" ON "Team"("defaultPoolId");
```

### Prisma Schema 更新

```prisma
model Team {
  // ... 现有字段
  defaultPoolId String?
  pools         Pool[]  @relation("TeamPools")
  defaultPool   Pool?   @relation("TeamDefaultPool", fields: [defaultPoolId], references: [id], onDelete: SetNull)

  @@index([defaultPoolId])
}

model Pool {
  // ... 现有字段
  team              Team?   @relation("TeamPools", fields: [teamId], references: [id])
  defaultForTeams   Team[]  @relation("TeamDefaultPool")
}
```

## 验收标准

- [ ] 数据库迁移成功执行
- [ ] Team 表包含 `defaultPoolId` 字段
- [ ] 团队管理页面可以选择默认池子
- [ ] 选择后可以保存并正确关联
- [ ] 调用日志表格显示"池子"列
- [ ] 池子信息正确显示（通过 Channel 关联）
- [ ] API 返回数据包含 poolName 和 poolId
- [ ] 未设置默认池的团队不受影响（向后兼容）

## 技术实现要点

### 1. 数据完整性

- 外键使用 `ON DELETE SET NULL`，删除池子时自动清空引用
- 添加索引提升查询性能

### 2. 权限控制

- 只有 TEAM_ADMIN 可以设置默认池
- 验证池子的可用性（SHARED 或本团队的 DEDICATED）

### 3. 向后兼容

- `defaultPoolId` 可为空
- 为空时行为与现在一致（使用 SHARED 池）

### 4. 查询优化

- 调用日志查询使用 `include` 预加载关联数据
- 避免 N+1 查询问题

## 时间估算

- 数据库迁移：30 分钟
- 后端 API：1.5 小时
- 前端界面：1.5 小时
- 测试验证：1 小时

**总计**：约 4.5 小时
