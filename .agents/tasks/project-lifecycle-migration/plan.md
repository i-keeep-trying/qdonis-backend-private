# Project lifecycle -> Nest (no qdonis-core, no Supabase)

Branch: `feature/project-lifecycle-backend` (from teammate's `feature/core-migration-studio-agent-catalog` @ 21c4519).
Source of truth for behaviour: old FE `qdonis/` (see investigation.md).

## Decisions
- D1 Storage: private S3 bucket. Downloads = CloudFront signed URLs (S3 presigned GET only outside production when
  CloudFront is unset). Large uploads = S3 presigned PUT + `complete` (server HEADs and verifies). Small spec documents =
  multipart through the API (server extracts text). S3 creds: AWS key pair if set, else SDK default chain (IAM role).
- D2 S3 objects are never orphaned: a DB trigger on `stored_files` DELETE enqueues the key into `storage_deletions`;
  a sweeper drains it (covers cascades from user/project deletion). Stale PENDING uploads are swept too.
- D3 Project roles = old matrix (viewer/editor/admin/owner). Team projects: team OWNER/ADMIN -> project ADMIN,
  MEMBER -> EDITOR. Platform ADMIN -> read-only VIEWER on any project (old admin "view project").
- D4 Only the owner can grant/revoke the project ADMIN role or change an ADMIN member (anti-escalation).
- D5 Invitation tokens stored as SHA-256 hashes. Share-link tokens stored as-is so links stay re-copyable (old UX);
  DB read access already exposes project data, so hashing them buys nothing. Link passwords = argon2.
- D6 Accepting a project/team invitation requires the account email to match and be verified.
- D7 Saves use optimistic concurrency (`revision`); stale writes -> 409 REVISION_CONFLICT.
- D8 Progress: studio graph present -> ready stages on the active branch / 7; else legacy 10-step formula.
- D9 Team token pool: AI steps in a team project are charged to the team owner, within the team's tokenLimit,
  recorded in `team_token_usage`. Teams need an active TEAMS or ENTERPRISE plan.
- D10 All prompts and LLM calls live in BE modules; each step has its own step key (multiplier) and charges
  carry `projectId` + `step` in ledger metadata.

## Phases
- [x] P1 Storage + Files, Projects (CRUD/list/duplicate/versions/progress/admin view), Access, Sharing
      (members/invitations/share links/activity), Teams, Chat history, Project usage.
- [ ] P2 AI steps: naming, stage params, mandatory params, requirements/constraints, topology recommendation,
      schematic data, magnetics extraction, sourcing (+Mouser), component evaluation, patents.
- [ ] P3 Engines: magnetics, thermal, MTBF, EMC, BOM (+xlsx), step summaries + report PDF.

## Status
- P1 done: modules storage, projects, sharing, teams, project-chat; migrations 20261009233910_project_lifecycle + 20261010000000_stage_blob_ready_index; e2e test/projects.e2e-spec.ts (14), unit specs green.
- Known pre-existing lint error in teammate file src/topologies/topologies.types.ts:25 (not ours).
- P2a done: src/design (AiStepRunner w/ team pool, SpecDocumentsService PDF->Bedrock document block, SSE helper). Endpoints: name/generate (+auto on create), design-intent/analyze + parameters edit, requirements/process, topologies/recommend (cached), studio/specs, specs/approve, studio/constraints, constraints/generate. e2e test/design.e2e-spec.ts (8) green.
- P2 remaining: schematic data, sourcing+Mouser+search terms+evaluation, patents, magnetics LLM extraction. P3: magnetics/thermal engines, MTBF, EMC, BOM, summaries, report PDF.
- P3a done: src/engines (magnetics, thermal, MTBF, EMC ported verbatim, lint-clean); src/studio-stages: POST /projects/:id/studio/magnetics|thermal (entered + devices + circuit/sim via CIRCUIT_DATA_PROVIDER seam, default 503 STAGE_NOT_AVAILABLE), POST /projects/:id/mtbf, /calculators/{emc/scan,emc/spectrum,mtbf,mtbf/options,magnetics/options}. e2e test/stages.e2e-spec.ts (4).
