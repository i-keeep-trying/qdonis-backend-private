/** Worker-thread entry: runs one {@link runJob} and posts the outcome. */

import { parentPort, workerData } from 'node:worker_threads';

import { runJob, type ComputeKind } from './compute.jobs';

const job = workerData as { kind: ComputeKind; args: never };

runJob(job.kind, job.args).then(
  (result) => parentPort?.postMessage({ ok: true, result }),
  (error: unknown) =>
    parentPort?.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code:
        error instanceof Error && 'code' in error
          ? String((error as NodeJS.ErrnoException).code)
          : null,
    }),
);
