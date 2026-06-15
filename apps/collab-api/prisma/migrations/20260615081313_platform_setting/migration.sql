-- 平台设置键值表（platform 级，平台 Admin 维护）。
-- key 为主键（如 platformName/logoUrl）；value 为 String，由调用方按 key 解析。
-- updatedById 记录最后修改人（FK User，onDelete SetNull，Admin 被禁用后设置记录保留但作者置空）。

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- AddForeignKey
ALTER TABLE "PlatformSetting" ADD CONSTRAINT "PlatformSetting_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
