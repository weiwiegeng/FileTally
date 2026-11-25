import { useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { useTaskStore, makeTaskId } from '../../stores/taskStore';

/**
 * Global listeners that keep TaskCenter in sync with backend progress events.
 * Mount once near the app root.
 */
export const TaskBridge: React.FC = () => {
  const { t } = useTranslation();

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];

    const bind = async () => {
      unlisteners.push(
        await listen<{
          currentFile?: string;
          currentIndex?: number;
          totalFiles?: number;
          bytesTransferred?: number;
          totalBytes?: number;
          percentage?: number;
          stage?: string;
        }>('transfer-progress', (event) => {
          const p = event.payload;
          const { tasks, updateProgress, upsertTask } = useTaskStore.getState();
          let task = tasks.find(
            (x) => x.kind === 'transfer' && (x.status === 'running' || x.status === 'queued')
          );
          if (!task) {
            const id = makeTaskId('transfer');
            upsertTask({
              id,
              kind: 'transfer',
              title: p.currentFile || t('tasks.titles.transfer'),
              status: 'running',
              progress: {
                current: p.currentIndex || 0,
                total: p.totalFiles || 0,
                percentage: p.percentage || 0,
                message: p.currentFile,
                stage: p.stage,
              },
              startedAt: Date.now(),
              cancellable: true,
            });
            task = useTaskStore.getState().tasks.find((x) => x.id === id);
          }
          if (!task) return;
          const pct =
            p.percentage ??
            (p.totalBytes && p.totalBytes > 0
              ? Math.round(((p.bytesTransferred || 0) / p.totalBytes) * 100)
              : p.totalFiles && p.totalFiles > 0
                ? Math.round(((p.currentIndex || 0) / p.totalFiles) * 100)
                : 0);
          updateProgress(task.id, {
            current: p.currentIndex || 0,
            total: p.totalFiles || 0,
            percentage: pct,
            message: p.currentFile,
            stage: p.stage,
            status: p.stage === 'cancelled' ? 'cancelled' : 'running',
          });
        })
      );

      unlisteners.push(
        await listen<{
          jobId: number;
          stage: string;
          current: number;
          total: number;
          message: string;
        }>('excel-check-progress', (event) => {
          const p = event.payload;
          const { tasks, updateProgress, upsertTask, completeTask } = useTaskStore.getState();
          let task = tasks.find(
            (x) =>
              x.kind === 'excel' &&
              (x.backendJobId === p.jobId ||
                ((x.status === 'running' || x.status === 'queued') && !x.backendJobId))
          );
          if (!task) {
            const id = makeTaskId('excel', p.jobId);
            upsertTask({
              id,
              kind: 'excel',
              title: p.message || t('tasks.titles.excel'),
              status: 'running',
              backendJobId: p.jobId,
              progress: {
                current: p.current,
                total: p.total,
                percentage: p.total > 0 ? Math.round((p.current / p.total) * 100) : 0,
                message: p.message,
                stage: p.stage,
              },
              startedAt: Date.now(),
              cancellable: true,
            });
            return;
          }
          if (p.stage === 'done') {
            completeTask(task.id, 'completed');
            return;
          }
          if (p.stage === 'cancelled') {
            completeTask(task.id, 'cancelled');
            return;
          }
          updateProgress(task.id, {
            current: p.current,
            total: p.total,
            message: p.message,
            stage: p.stage,
            status: 'running',
          });
        })
      );

      unlisteners.push(
        await listen<{
          jobId?: number;
          stage: string;
          current: number;
          total: number;
          message: string;
        }>('analysis-progress', (event) => {
          const p = event.payload;
          const { tasks, updateProgress, upsertTask, completeTask } = useTaskStore.getState();
          let task = tasks.find(
            (x) =>
              x.kind === 'analysis' &&
              (x.status === 'running' || x.status === 'queued') &&
              (p.jobId == null || !x.backendJobId || x.backendJobId === p.jobId)
          );
          if (!task) {
            const id = makeTaskId('analysis', p.jobId);
            upsertTask({
              id,
              kind: 'analysis',
              title: p.message || t('tasks.titles.analysis'),
              status: 'running',
              backendJobId: p.jobId,
              progress: {
                current: p.current,
                total: p.total,
                percentage: p.total > 0 ? Math.round((p.current / p.total) * 100) : 0,
                message: p.message,
                stage: p.stage,
              },
              startedAt: Date.now(),
              cancellable: true,
            });
            return;
          }
          if (p.stage === 'complete' || p.stage === 'cancelled') {
            completeTask(task.id, p.stage === 'cancelled' ? 'cancelled' : 'completed');
            return;
          }
          updateProgress(task.id, {
            current: p.current,
            total: p.total,
            message: p.message,
            stage: p.stage,
            status: 'running',
          });
        })
      );

      unlisteners.push(
        await listen<{
          jobId: number;
          stage: string;
          current: number;
          total: number;
          message: string;
        }>('search-progress', (event) => {
          const p = event.payload;
          const { tasks, updateProgress, upsertTask, completeTask } = useTaskStore.getState();
          let task = tasks.find(
            (x) =>
              x.kind === 'search' &&
              (x.backendJobId === p.jobId ||
                ((x.status === 'running' || x.status === 'queued') && !x.backendJobId))
          );
          if (!task) {
            const id = makeTaskId('search', p.jobId);
            upsertTask({
              id,
              kind: 'search',
              title: p.message || t('tasks.titles.search'),
              status: 'running',
              backendJobId: p.jobId,
              progress: {
                current: p.current,
                total: p.total,
                percentage: p.total > 0 ? Math.round((p.current / p.total) * 100) : 0,
                message: p.message,
                stage: p.stage,
              },
              startedAt: Date.now(),
              cancellable: true,
            });
            return;
          }
          if (p.stage === 'done' || p.stage === 'cancelled') {
            completeTask(task.id, p.stage === 'cancelled' ? 'cancelled' : 'completed');
            return;
          }
          updateProgress(task.id, {
            current: p.current,
            total: p.total,
            message: p.message,
            stage: p.stage,
            status: 'running',
          });
        })
      );

      unlisteners.push(
        await listen<{
          jobId: number;
          stage: string;
          current: number;
          total: number;
          message: string;
        }>('sync-progress', (event) => {
          const p = event.payload;
          const { tasks, updateProgress, upsertTask, completeTask } = useTaskStore.getState();
          let task = tasks.find(
            (x) =>
              x.kind === 'sync' &&
              (x.backendJobId === p.jobId ||
                ((x.status === 'running' || x.status === 'queued') && !x.backendJobId))
          );
          const displayMessage =
            p.message ||
            (p.stage === 'syncing'
              ? t('sync.progressStarting')
              : p.stage === 'deleting'
                ? t('sync.progressDeleting')
                : p.message);
          if (!task) {
            const id = makeTaskId('sync', p.jobId);
            upsertTask({
              id,
              kind: 'sync',
              title: t('tasks.kind.sync'),
              status: 'running',
              backendJobId: p.jobId,
              progress: {
                current: p.current,
                total: p.total,
                percentage: p.total > 0 ? Math.round((p.current / p.total) * 100) : 0,
                message: displayMessage,
                stage: p.stage,
              },
              startedAt: Date.now(),
              cancellable: true,
            });
            return;
          }
          if (p.stage === 'done' || p.stage === 'cancelled') {
            completeTask(task.id, p.stage === 'cancelled' ? 'cancelled' : 'completed');
            return;
          }
          updateProgress(task.id, {
            current: p.current,
            total: p.total,
            message: displayMessage,
            stage: p.stage,
            status: 'running',
          });
        })
      );
    };

    void bind();
    return () => {
      unlisteners.forEach((u) => u());
    };
  }, [t]);

  return null;
};

export default TaskBridge;