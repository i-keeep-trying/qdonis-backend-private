-- AlterEnum
-- The EMC and Components stages (entry-step mode). MTBF and BOM come from
-- 20261016120000_studio_stage_mtbf and 20261016180000_studio_stage_bom.
ALTER TYPE "studio_stage" ADD VALUE IF NOT EXISTS 'emc';
ALTER TYPE "studio_stage" ADD VALUE IF NOT EXISTS 'components';
