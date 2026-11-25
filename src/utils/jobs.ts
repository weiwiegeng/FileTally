import { invoke } from '@tauri-apps/api/core';

export type JobKind =
  | 'transfer'
  | 'search'
  | 'sync'
  | 'analysis'
  | 'excel'
  | 'ruleFilter'
  | 'organize';

export async function prepareJob(kind: JobKind): Promise<number> {
  return invoke<number>('prepare_job', { kind });
}

export async function cancelJob(jobId?: number | null, kind?: JobKind): Promise<void> {
  await invoke('cancel_job', {
    jobId: jobId && jobId > 0 ? jobId : null,
    kind: kind ?? null,
  });
}
