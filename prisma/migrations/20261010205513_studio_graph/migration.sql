-- Studio graph in tables: nodes (stage results), branches (shared, named heads)
-- and per-user branch cursors. Existing projects keep their graph in
-- projects.data.studio until first opened; the API then moves it here once.

-- CreateEnum
CREATE TYPE "studio_node_source" AS ENUM ('agent', 'user', 'upload', 'legacy');

-- CreateEnum
CREATE TYPE "studio_node_status" AS ENUM ('running', 'ready', 'error');

-- CreateEnum
CREATE TYPE "studio_stage" AS ENUM ('specs', 'visualization', 'design', 'simulation', 'devices', 'magnetics', 'thermal');

-- CreateTable
CREATE TABLE "studio_branch_cursors" (
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "branch_id" VARCHAR(100) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "studio_branch_cursors_pkey" PRIMARY KEY ("project_id","user_id")
);

-- CreateTable
CREATE TABLE "studio_branches" (
    "id" VARCHAR(100) NOT NULL,
    "project_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "name_key" VARCHAR(100) NOT NULL,
    "head_node_id" VARCHAR(100),
    "forked_from_node_id" VARCHAR(100),
    "color_index" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "studio_branches_pkey" PRIMARY KEY ("project_id","id")
);

-- CreateTable
CREATE TABLE "studio_nodes" (
    "id" VARCHAR(100) NOT NULL,
    "project_id" UUID NOT NULL,
    "parent_id" VARCHAR(100),
    "stage" "studio_stage" NOT NULL,
    "status" "studio_node_status" NOT NULL DEFAULT 'ready',
    "error" TEXT,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "data" JSONB NOT NULL DEFAULT '{}',
    "source" "studio_node_source" NOT NULL DEFAULT 'agent',
    "summary" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "studio_nodes_pkey" PRIMARY KEY ("project_id","id")
);

-- CreateIndex
CREATE INDEX "studio_branches_project_id_position_idx" ON "studio_branches"("project_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "studio_branches_project_id_name_key_key" ON "studio_branches"("project_id", "name_key");

-- CreateIndex
CREATE INDEX "studio_nodes_project_id_parent_id_idx" ON "studio_nodes"("project_id", "parent_id");

-- CreateIndex
CREATE INDEX "studio_nodes_project_id_created_at_idx" ON "studio_nodes"("project_id", "created_at");

-- AddForeignKey
ALTER TABLE "studio_branch_cursors" ADD CONSTRAINT "studio_branch_cursors_project_id_branch_id_fkey" FOREIGN KEY ("project_id", "branch_id") REFERENCES "studio_branches"("project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio_branch_cursors" ADD CONSTRAINT "studio_branch_cursors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio_branches" ADD CONSTRAINT "studio_branches_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio_branches" ADD CONSTRAINT "studio_branches_project_id_head_node_id_fkey" FOREIGN KEY ("project_id", "head_node_id") REFERENCES "studio_nodes"("project_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "studio_branches" ADD CONSTRAINT "studio_branches_project_id_forked_from_node_id_fkey" FOREIGN KEY ("project_id", "forked_from_node_id") REFERENCES "studio_nodes"("project_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "studio_branches" ADD CONSTRAINT "studio_branches_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio_nodes" ADD CONSTRAINT "studio_nodes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio_nodes" ADD CONSTRAINT "studio_nodes_project_id_parent_id_fkey" FOREIGN KEY ("project_id", "parent_id") REFERENCES "studio_nodes"("project_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "studio_nodes" ADD CONSTRAINT "studio_nodes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
