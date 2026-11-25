import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { message, notification } from 'antd';
import { useTranslation } from 'react-i18next';
import { useSyncPresetsStore } from '../../stores/syncPresetsStore';
import { mapBackendError } from '../../utils/backendError';

const runningPresetIds = new Set<string>();

/** In-app interval sync for presets with intervalMinutes &gt; 0. */
export const SyncScheduler: React.FC = () => {
  const { t } = useTranslation();
  const presets = useSyncPresetsStore((s) => s.presets);
  const updatePreset = useSyncPresetsStore((s) => s.updatePreset);

  useEffect(() => {
    const timers: ReturnType<typeof setInterval>[] = [];

    for (const preset of presets) {
      if (!preset.intervalMinutes || preset.intervalMinutes <= 0) continue;
      const ms = preset.intervalMinutes * 60 * 1000;
      const timer = setInterval(() => {
        if (runningPresetIds.has(preset.id)) return;
        runningPresetIds.add(preset.id);
        void (async () => {
          notification.info({
            message: t('sync.schedulerStarted'),
            description: preset.name,
            duration: 4,
          });
          try {
            const jobId = await (await import('../../utils/jobs')).prepareJob('sync');
            await invoke('compare_sync', {
              source: preset.source,
              dest: preset.dest,
              mode: preset.mode,
            });
            await invoke('run_sync', {
              source: preset.source,
              dest: preset.dest,
              deleteExtras: preset.deleteExtras ?? false,
              jobId,
              mode: preset.mode,
              conflictResolution: preset.conflictResolution,
            });
            updatePreset(preset.id, {
              lastRunAt: Date.now(),
              lastRunOk: true,
              lastError: undefined,
            });
          } catch (e) {
            const errText = mapBackendError(e);
            message.error(errText);
            notification.error({
              message: t('sync.schedulerFailed'),
              description: preset.name,
            });
            updatePreset(preset.id, {
              lastRunAt: Date.now(),
              lastRunOk: false,
              lastError: errText,
            });
          } finally {
            runningPresetIds.delete(preset.id);
          }
        })();
      }, ms);
      timers.push(timer);
    }

    return () => {
      for (const id of timers) clearInterval(id);
    };
  }, [presets, t, updatePreset]);

  return null;
};

export default SyncScheduler;