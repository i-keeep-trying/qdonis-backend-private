-- CreateEnum
CREATE TYPE "chat_sender" AS ENUM ('USER', 'AI');

-- CreateEnum
CREATE TYPE "project_activity_type" AS ENUM ('VIEW', 'EDIT', 'SHARE', 'INVITE', 'COMMENT', 'CREATE', 'DELETE', 'RENAME', 'DUPLICATE', 'EXPORT', 'ACCESS_GRANTED', 'ACCESS_REVOKED', 'ROLE_CHANGED');

-- CreateEnum
CREATE TYPE "project_role" AS ENUM ('VIEWER', 'EDITOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "share_link_type" AS ENUM ('ANYONE_WITH_LINK', 'DOMAIN_RESTRICTED', 'ONE_TIME_USE', 'PASSWORD_PROTECTED');

-- CreateEnum
CREATE TYPE "stored_file_kind" AS ENUM ('DOCUMENT', 'STAGE_BLOB', 'EXPORT');

-- CreateEnum
CREATE TYPE "stored_file_status" AS ENUM ('PENDING', 'READY');

-- CreateEnum
CREATE TYPE "team_role" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateTable
CREATE TABLE "project_activity" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID,
    "type" "project_activity_type" NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "stage" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_chat_messages" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "sender" "chat_sender" NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_invitations" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "project_role" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "message" TEXT,
    "invited_by_id" UUID,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "accepted_by_id" UUID,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "project_role" NOT NULL,
    "granted_by_id" UUID,
    "share_link_id" UUID,
    "expires_at" TIMESTAMP(3),
    "last_accessed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_versions" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "description" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "team_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "data_bytes" INTEGER NOT NULL DEFAULT 2,
    "progress_completed" INTEGER NOT NULL DEFAULT 0,
    "progress_total" INTEGER NOT NULL DEFAULT 10,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "last_accessed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_links" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "type" "share_link_type" NOT NULL,
    "role" "project_role" NOT NULL,
    "allowed_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "password_hash" TEXT,
    "max_uses" INTEGER,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "share_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_deletions" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "not_before" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_deletions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stored_files" (
    "id" UUID NOT NULL,
    "owner_id" UUID,
    "project_id" UUID,
    "kind" "stored_file_kind" NOT NULL,
    "status" "stored_file_status" NOT NULL DEFAULT 'PENDING',
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT,
    "extracted_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_invitations" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "team_role" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by_id" UUID,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "team_role" NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_token_usage" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "user_id" UUID,
    "project_id" UUID,
    "tokens" INTEGER NOT NULL,
    "operation" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_token_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "token_limit" INTEGER,
    "tokens_used" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_activity_project_id_created_at_idx" ON "project_activity"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "project_chat_messages_project_id_user_id_created_at_idx" ON "project_chat_messages"("project_id", "user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "project_invitations_token_hash_key" ON "project_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "project_invitations_email_idx" ON "project_invitations"("email");

-- CreateIndex
CREATE UNIQUE INDEX "project_invitations_project_id_email_key" ON "project_invitations"("project_id", "email");

-- CreateIndex
CREATE INDEX "project_members_user_id_idx" ON "project_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_members_project_id_user_id_key" ON "project_members"("project_id", "user_id");

-- CreateIndex
CREATE INDEX "project_versions_project_id_created_at_idx" ON "project_versions"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "projects_owner_id_last_accessed_at_idx" ON "projects"("owner_id", "last_accessed_at" DESC);

-- CreateIndex
CREATE INDEX "projects_team_id_last_accessed_at_idx" ON "projects"("team_id", "last_accessed_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "share_links_token_key" ON "share_links"("token");

-- CreateIndex
CREATE INDEX "share_links_project_id_is_active_idx" ON "share_links"("project_id", "is_active");

-- CreateIndex
CREATE INDEX "storage_deletions_not_before_idx" ON "storage_deletions"("not_before");

-- CreateIndex
CREATE UNIQUE INDEX "stored_files_key_key" ON "stored_files"("key");

-- CreateIndex
CREATE INDEX "stored_files_project_id_kind_idx" ON "stored_files"("project_id", "kind");

-- CreateIndex
CREATE INDEX "stored_files_owner_id_kind_idx" ON "stored_files"("owner_id", "kind");

-- CreateIndex
CREATE INDEX "stored_files_status_created_at_idx" ON "stored_files"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "team_invitations_token_hash_key" ON "team_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "team_invitations_email_idx" ON "team_invitations"("email");

-- CreateIndex
CREATE UNIQUE INDEX "team_invitations_team_id_email_key" ON "team_invitations"("team_id", "email");

-- CreateIndex
CREATE INDEX "team_members_user_id_idx" ON "team_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_members_team_id_user_id_key" ON "team_members"("team_id", "user_id");

-- CreateIndex
CREATE INDEX "team_token_usage_team_id_created_at_idx" ON "team_token_usage"("team_id", "created_at");

-- CreateIndex
CREATE INDEX "team_token_usage_team_id_user_id_idx" ON "team_token_usage"("team_id", "user_id");

-- CreateIndex
CREATE INDEX "teams_owner_id_idx" ON "teams"("owner_id");

-- AddForeignKey
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_chat_messages" ADD CONSTRAINT "project_chat_messages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_chat_messages" ADD CONSTRAINT "project_chat_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_accepted_by_id_fkey" FOREIGN KEY ("accepted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_share_link_id_fkey" FOREIGN KEY ("share_link_id") REFERENCES "share_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_token_usage" ADD CONSTRAINT "team_token_usage_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_token_usage" ADD CONSTRAINT "team_token_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_token_usage" ADD CONSTRAINT "team_token_usage_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written: invariants Prisma cannot express.
-- ---------------------------------------------------------------------------

-- One stage blob per (project, name); other kinds may repeat names.
CREATE UNIQUE INDEX "stored_files_project_stage_blob_name_key"
  ON "stored_files"("project_id", "name") WHERE "kind" = 'STAGE_BLOB';

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_name_length" CHECK (char_length("name") BETWEEN 1 AND 200),
  ADD CONSTRAINT "projects_counters_non_negative" CHECK (
    "data_bytes" >= 0 AND "revision" >= 0 AND "progress_completed" >= 0 AND "progress_total" > 0
  ),
  ADD CONSTRAINT "projects_data_is_object" CHECK (jsonb_typeof("data") = 'object');

ALTER TABLE "share_links"
  ADD CONSTRAINT "share_links_uses_valid" CHECK ("uses" >= 0 AND ("max_uses" IS NULL OR "max_uses" > 0)),
  ADD CONSTRAINT "share_links_role_valid" CHECK ("role" IN ('VIEWER', 'EDITOR')),
  ADD CONSTRAINT "share_links_password_matches_type" CHECK (
    ("type" = 'PASSWORD_PROTECTED') = ("password_hash" IS NOT NULL)
  );

ALTER TABLE "teams"
  ADD CONSTRAINT "teams_tokens_valid" CHECK (
    "tokens_used" >= 0 AND ("token_limit" IS NULL OR "token_limit" >= 0)
  ),
  ADD CONSTRAINT "teams_name_length" CHECK (char_length("name") BETWEEN 1 AND 100);

ALTER TABLE "team_invitations"
  ADD CONSTRAINT "team_invitations_role_valid" CHECK ("role" IN ('ADMIN', 'MEMBER'));

ALTER TABLE "team_token_usage"
  ADD CONSTRAINT "team_token_usage_tokens_positive" CHECK ("tokens" > 0);

ALTER TABLE "stored_files"
  ADD CONSTRAINT "stored_files_size_non_negative" CHECK ("size_bytes" >= 0);

-- Every deleted stored_files row (direct delete or cascade from a project or
-- user) queues its S3 key, so objects are never orphaned.
CREATE FUNCTION "enqueue_storage_deletion"() RETURNS trigger AS $$
BEGIN
  INSERT INTO "storage_deletions" ("id", "key") VALUES (gen_random_uuid(), OLD."key");
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stored_files_enqueue_deletion"
  AFTER DELETE ON "stored_files"
  FOR EACH ROW EXECUTE FUNCTION "enqueue_storage_deletion"();