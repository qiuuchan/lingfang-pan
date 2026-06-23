-- ModelPricing 加 contextWindow 列（每模型最大上下文窗口，供前端用量管理与压缩阈值）。
ALTER TABLE "ModelPricing" ADD COLUMN "contextWindow" INTEGER;
