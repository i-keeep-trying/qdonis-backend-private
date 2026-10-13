-- A replacement stage blob is uploaded as a new PENDING row while the current
-- READY one is still served; uniqueness only applies to READY rows.
DROP INDEX "stored_files_project_stage_blob_name_key";

CREATE UNIQUE INDEX "stored_files_project_stage_blob_name_key"
  ON "stored_files"("project_id", "name")
  WHERE "kind" = 'STAGE_BLOB' AND "status" = 'READY';