-- CreateEnum
CREATE TYPE "simulation_run_status" AS ENUM ('queued', 'running', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "simulation_runs" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "node_id" VARCHAR(100) NOT NULL,
    "status" "simulation_run_status" NOT NULL DEFAULT 'queued',
    "input" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "simulation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "simulation_runs_status_created_at_idx" ON "simulation_runs"("status", "created_at");

-- CreateIndex
CREATE INDEX "simulation_runs_project_id_node_id_idx" ON "simulation_runs"("project_id", "node_id");

-- AddForeignKey
ALTER TABLE "simulation_runs" ADD CONSTRAINT "simulation_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulation_runs" ADD CONSTRAINT "simulation_runs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
