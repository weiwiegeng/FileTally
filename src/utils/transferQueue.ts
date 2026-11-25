import type {
  ConflictResolution,
  TransferDirection,
  TransferItem,
  TransferJobSnapshot,
} from '../stores/transferStore';

export const TRANSFER_QUEUE_KEY = 'filetally-transfer-queue';

export function parseTransferQueue(raw: string | null): TransferJobSnapshot[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as TransferJobSnapshot[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function serializeTransferQueue(queue: TransferJobSnapshot[]): string | null {
  if (queue.length === 0) return null;
  return JSON.stringify(queue);
}

export function transferRetryPayload(job: TransferJobSnapshot) {
  return {
    action: 'transfer' as const,
    resolution: job.resolution,
    sourcePaths: job.sourceItems.map((i) => i.sourcePath),
    sourceItems: job.sourceItems,
    targetPath: job.targetPath,
    sourceConnectionName: job.sourceConnectionName,
    targetConnectionName: job.targetConnectionName,
    direction: job.direction,
  };
}

export function isValidQueueEntry(
  entry: unknown
): entry is TransferJobSnapshot {
  if (!entry || typeof entry !== 'object') return false;
  const o = entry as TransferJobSnapshot;
  return (
    typeof o.targetPath === 'string' &&
    Array.isArray(o.sourceItems) &&
    (o.resolution === 'overwrite' ||
      o.resolution === 'rename' ||
      o.resolution === 'skip') &&
    (o.direction === 'upload' || o.direction === 'download')
  );
}

export function filterValidQueue(entries: unknown[]): TransferJobSnapshot[] {
  return entries.filter(isValidQueueEntry);
}

export type QueuePersistShape = {
  resolution: ConflictResolution;
  direction: TransferDirection;
  sourceItems: TransferItem[];
  targetPath: string;
};