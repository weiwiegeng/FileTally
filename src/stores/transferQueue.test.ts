import { describe, it, expect } from 'vitest';
import {
  TRANSFER_QUEUE_KEY,
  parseTransferQueue,
  serializeTransferQueue,
  transferRetryPayload,
  filterValidQueue,
} from '../utils/transferQueue';
import type { TransferJobSnapshot } from './transferStore';

const sampleJob: TransferJobSnapshot = {
  resolution: 'rename',
  direction: 'upload',
  targetPath: '/tmp/dest',
  sourceConnectionName: null,
  targetConnectionName: 'NAS',
  sourceItems: [
    {
      id: 'a',
      sourcePath: '/tmp/a.txt',
      fileName: 'a.txt',
      fileType: 'file',
      size: 10,
      sizeFormatted: '10 B',
    },
  ],
};

describe('transferQueue persist', () => {
  it('exports stable localStorage key', () => {
    expect(TRANSFER_QUEUE_KEY).toBe('filetally-transfer-queue');
  });

  it('round-trips queue JSON', () => {
    const raw = serializeTransferQueue([sampleJob]);
    expect(raw).toBeTruthy();
    const parsed = parseTransferQueue(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].targetPath).toBe('/tmp/dest');
    expect(parsed[0].sourceItems[0].sourcePath).toBe('/tmp/a.txt');
  });

  it('returns empty on invalid JSON', () => {
    expect(parseTransferQueue('not-json')).toEqual([]);
    expect(parseTransferQueue(null)).toEqual([]);
  });

  it('filters invalid queue entries', () => {
    const mixed = [sampleJob, { bad: true }, null];
    expect(filterValidQueue(mixed)).toHaveLength(1);
  });
});

describe('transferRetryPayload', () => {
  it('maps job snapshot for task retry', () => {
    const payload = transferRetryPayload(sampleJob);
    expect(payload.action).toBe('transfer');
    expect(payload.resolution).toBe('rename');
    expect(payload.sourcePaths).toEqual(['/tmp/a.txt']);
    expect(payload.targetPath).toBe('/tmp/dest');
    expect(payload.targetConnectionName).toBe('NAS');
    expect(payload.direction).toBe('upload');
  });
});