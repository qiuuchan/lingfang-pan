-- 团队指定默认资源池功能
-- 添加 Team.defaultPoolId 字段，允许团队选择默认使用的池子

-- 1. 添加 defaultPoolId 列到 Team 表（可空，兼容现有数据）
ALTER TABLE "Team" ADD COLUMN "defaultPoolId" TEXT;

-- 2. 添加外键约束（删除池子时自动置空）
ALTER TABLE "Team" ADD CONSTRAINT "Team_defaultPoolId_fkey"
  FOREIGN KEY ("defaultPoolId")
  REFERENCES "Pool"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- 3. 添加索引（提升查询性能）
CREATE INDEX "Team_defaultPoolId_idx" ON "Team"("defaultPoolId");
