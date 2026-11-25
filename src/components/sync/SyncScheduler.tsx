import { useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { message, notification } from 'antd';
import { useTranslation } from 'react-i18next';
import { makeTaskId, useSyncPresetsStore, useTaskStore } from '../../stores';
import { mapBackendError } from '../../utils/backendError';
import { withSyncLock } from '../../utils/syncLock';

const runningPresetIds = new Set<string>();

type TimerEntry = {
  presetId: string;
  intervalMinutes: number;
  signature: string;
  handle: ReturnType<typeof setInterval>;
};

/** Stable schedule fingerprint — excludes lastRun* so finishing one preset does not reset others. */
function scheduleSignature(p: {
  id: string;
  intervalMinutes?: number;
  source: string;
  dest: string;
  mode: string;
  deleteExtras?: boolean;
  conflictResolution?: string;
}): string | null {
  if (!p.intervalMinutes || p.intervalMinutes <= 0) return null;
  return [
    p.id,
    p.intervalMinutes,
    p.source,
    p.dest,
    p.mode,
    p.deleteExtras ? '1' : '0',
    p.conflictResolution || 'skip',
  ].join('|');
}

/** In-app interval sync for presets with intervalMinutes &gt; 0. */
export const SyncScheduler: React.FC = () => {
  const { t } = useTranslation();
  const presets = useSyncPresetsStore((s) => s.presets);
  const updatePreset = useSyncPresetsStore((s) => s.updatePreset);
  const timersRef = useRef<Map<string, TimerEntry>>(new Map());

  const scheduleSpecs = useMemo(
    () =>
      presets
        .map((p) => {
          const signature = scheduleSignature(p);
          if (!signature) return null;
          return {
            id: p.id,
            name: p.name,
            intervalMinutes: p.intervalMinutes!,
            signature,
            source: p.source,
            dest: p.dest,
            mode: p.mode,
            deleteExtras: p.deleteExtras ?? false,
            conflictResolution: p.conflictResolution,
          };
        })
        .filter((x): x is NonNullable<typeof x> => Boolean(x)),
    [presets]
  );

  useEffect(() => {
    const wanted = new Map(scheduleSpecs.map((s) => [s.id, s]));
    const timers = timersRef.current;

    for (const [id, entry] of [...timers.entries()]) {
      const next = wanted.get(id);
      if (!next || next.signature !== entry.signature) {
        clearInterval(entry.handle);
        timers.delete(id);
      }
    }

    for (const spec of scheduleSpecs) {
      if (timers.has(spec.id)) continue;
      const ms = spec.intervalMinutes * 60 * 1000;
      const handle = setInterval(() => {
        if (runningPresetIds.has(spec.id)) return;
        runningPresetIds.add(spec.id);
        void (async () => {
          notification.info({
            message: t('sync.schedulerStarted'),
            description: spec.name,
            duration: 4,
          });
          let taskId = '';
          try {
            await withSyncLock(async () => {
              const jobId = await (await import('../../utils/jobs')).prepareJob('sync');
              taskId = makeTaskId('sync', jobId);
              useTaskStore.getState().upsertTask({
                id: taskId,
                kind: 'sync',
                title: spec.name || `${spec.source} → ${spec.dest}`,
                status: 'running',
                backendJobId: jobId,
                progress: { current: 0, total: 0, percentage: 0 },
                startedAt: Date.now(),
                cancellable: true,
              });
              await invoke('run_sync', {
                source: spec.source,
                dest: spec.dest,
                deleteExtras: spec.deleteExtras,
                jobId,
                mode: spec.mode,
                conflictResolution: spec.conflictResolution,
              });
            });
            if (taskId) useTaskStore.getState().completeTask(taskId, 'completed');
            updatePreset(spec.id, {
              lastRunAt: Date.now(),
              lastRunOk: true,
              lastError: undefined,
            });
          } catch (e) {
            const raw = String(e instanceof Error ? e.message : e);
            const busy =
              raw === 'sync_already_running' ||
              /FTERR:sync_already_running/i.test(raw);
            const errText = busy
              ? t('errors.sync_already_running')
              : mapBackendError(e);
            if (busy) {
              // Soft-skip: another sync owns the lock — do not mark the preset failed.
              if (taskId) useTaskStore.getState().completeTask(taskId, 'cancelled');
              return;
            }
            if (taskId) useTaskStore.getState().completeTask(taskId, 'failed', errText);
            message.error(errText);
            notification.error({
              message: t('sync.schedulerFailed'),
              description: spec.name,
            });
            updatePreset(spec.id, {
              lastRunAt: Date.now(),
              lastRunOk: false,
              lastError: errText,
            });
          } finally {
            runningPresetIds.delete(spec.id);
          }
        })();
      }, ms);
      timers.set(spec.id, {
        presetId: spec.id,
        intervalMinutes: spec.intervalMinutes,
        signature: spec.signature,
        handle,
      });
    }
  }, [scheduleSpecs, t, updatePreset]);

  useEffect(() => {
    return () => {
      for (const entry of timersRef.current.values()) {
        clearInterval(entry.handle);
      }
      timersRef.current.clear();
    };
  }, []);

  return null;
};

export default SyncScheduler;
