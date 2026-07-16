ALTER TABLE "WorkflowRelease"
ADD COLUMN "frozenClosure" JSONB NOT NULL DEFAULT '[]';
