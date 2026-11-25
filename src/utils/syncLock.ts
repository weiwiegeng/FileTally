/** Process-wide FE gate so manual SyncPanel runs and SyncScheduler do not overlap. */
let locked = false;

export function isSyncLocked(): boolean {
  return locked;
}

export async function withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  if (locked) {
    throw new Error('sync_already_running');
  }
  locked = true;
  try {
    return await fn();
  } finally {
    locked = false;
  }
}
