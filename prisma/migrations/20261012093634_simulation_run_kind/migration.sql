-- CreateEnum
CREATE TYPE "simulation_run_kind" AS ENUM ('simulation', 'design');

-- AlterTable
ALTER TABLE "simulation_runs" ADD COLUMN     "kind" "simulation_run_kind" NOT NULL DEFAULT 'simulation';
