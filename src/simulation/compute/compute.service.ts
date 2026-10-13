import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { Injectable } from '@nestjs/common';

import { runJob, type ComputeJobs, type ComputeKind } from './compute.jobs';

type Message<R> =
  { ok: true; result: R } | { ok: false; error: string; code: string | null };

/**
 * Runs CPU-bound simulation jobs (ngspice post-processing, loss engine,
 * device selection, waveform statistics) in a worker thread so the API's
 * event loop stays responsive. Without a compiled worker (ts-jest) the job
 * runs inline.
 */
@Injectable()
export class ComputeService {
  private readonly script = join(__dirname, 'compute.worker.js');

  run<K extends ComputeKind>(
    kind: K,
    args: ComputeJobs[K]['args'],
  ): Promise<ComputeJobs[K]['result']> {
    if (!existsSync(this.script)) return runJob(kind, args);
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.script, { workerData: { kind, args } });
      let settled = false;
      worker.once('message', (message: Message<ComputeJobs[K]['result']>) => {
        settled = true;
        if (message.ok) resolve(message.result);
        else {
          const error = new Error(message.error) as NodeJS.ErrnoException;
          if (message.code) error.code = message.code;
          reject(error);
        }
      });
      worker.once('error', (error: Error) => {
        settled = true;
        reject(error);
      });
      worker.once('exit', (code) => {
        if (!settled) reject(new Error(`Compute worker exited with ${code}`));
      });
    });
  }
}
