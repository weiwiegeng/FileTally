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
  useRemoteStore,
} from '../stores';

function connectionIdFromRemotePath(path: string): string | null {
  if (!path.startsWith('remote://')) return null;
  const rest = path.slice('remote://'.length);
  const id = rest.split('/')[0];
  return id || null;
}

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
        // remote:// sessions are in-memory; no session yet ≠ missing share — keep the root.
        if (path.startsWith('remote://')) continue;
        try {
          const ok = await invoke<boolean>('check_path_exists', { path });
          if (!ok) {
            clear(null);
            notification.warning({
              message: t('browser.dualPane.rootMissingTitle'),
              description: t('browser.dualPane.rootMissingBody', {
                side: t(`browser.dualPane.pane${side === 'left' ? 'Left' : 'Right'}`),
              }),
            });
          }
        } catch {
          /* ignore */
        }
      }
    })();
  }, [t]);

  // Soft-reconnect connections referenced by persisted dual-pane remote roots.
  useEffect(() => {
    void (async () => {
      const { leftRoot, rightRoot } = useDualPaneStore.getState();
      const remote = useRemoteStore.getState();
      const ids = new Set<string>();
      for (const path of [leftRoot, rightRoot]) {
        if (!path) continue;
        const id = connectionIdFromRemotePath(path);
        if (id) ids.add(id);
      }
      for (const id of ids) {
        const conn = remote.getConnection(id);
        if (!conn || conn.status === 'connected' || conn.status === 'connecting') continue;
        const ok = await useRemoteStore.getState().connect(id);
        if (ok) {
          notification.success({
            message: t('browser.dualPane.reconnectOk', { name: conn.name }),
            duration: 3,
          });
        } else {
          notification.warning({
            message: t('browser.dualPane.reconnectFail', { name: conn.name }),
            duration: 5,
          });
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
