import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../stores';

/** One-shot app boot: restore transfer bandwidth / concurrency. */
export const BootstrapEffects: React.FC = () => {
  useEffect(() => {
    const { transferBandwidthMBps, transferConcurrency } =
      useSettingsStore.getState().settings;
    const bytesPerSec = Math.round((transferBandwidthMBps || 0) * 1024 * 1024);
    void invoke('set_transfer_bandwidth_limit', { bytesPerSec }).catch(() => undefined);
    void invoke('set_transfer_concurrency', {
      max: Math.max(1, transferConcurrency || 1),
    }).catch(() => undefined);
  }, []);

  return null;
};

export default BootstrapEffects;
