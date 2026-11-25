import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Modal, notification } from 'antd';
import { useTranslation } from 'react-i18next';
import {
  clearPersistedTransferQueue,
  getQueuedTransfers,
  hasPersistedQueue,
  resumePersistedTransferQueue,
  useSettingsStore,
  useDualPaneStore,
} from '../stores';

/** One-shot app boot: restore transfer bandwidth / concurrency; resume queued transfers. */
export const BootstrapEffects: React.FC = () => {
  const { t } = useTranslation();

  useEffect(() => {
    const { transferBandwidthMBps, transferConcurrency } =
      useSettingsStore.getState().settings;
    const bytesPerSec = Math.round((transferBandwidthMBps || 0) * 1024 * 1024);
    void invoke('set_transfer_bandwidth_limit', { bytesPerSec }).catch(() => undefined);
    void invoke('set_transfer_concurrency', {
      max: Math.max(1, transferConcurrency || 1),
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    void invoke<number>('cleanup_r2r_temp', { maxAgeSecs: 86_400 }).catch(() => undefined);
  }, []);

  useEffect(() => {
    void (async () => {
      const { leftRoot, rightRoot, setLeftRoot, setRightRoot } = useDualPaneStore.getState();
      for (const [side, path, clear] of [
        ['left', leftRoot, setLeftRoot] as const,
        ['right', rightRoot, setRightRoot] as const,
      ]) {
        if (!path) continue;
        try {
          const ok = await invoke<boolean>('check_path_exists', { path });
          if (!ok) {
            clear(null);
            notification.warning({
              message: t('browser.dualPane.rootMissingTitle'),
              description: t('browser.dualPane.rootMissingBody', { side: t(`browser.dualPane.pane${side === 'left' ? 'Left' : 'Right'}`) }),
            });
          }
        } catch {
          /* ignore */
        }
      }
    })();
  }, [t]);

  useEffect(() => {
    if (!hasPersistedQueue()) return;
    const jobs = getQueuedTransfers();
    if (jobs.length === 0) return;

    Modal.confirm({
      title: t('transfer.resume.title'),
      content: t('transfer.resume.message', { count: jobs.length }),
      okText: t('transfer.resume.yes'),
      cancelText: t('transfer.resume.no'),
      onOk: () => resumePersistedTransferQueue(),
      onCancel: () => clearPersistedTransferQueue(),
    });
  }, [t]);

  return null;
};

export default BootstrapEffects;