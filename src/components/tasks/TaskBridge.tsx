import { useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useTaskStore, makeTaskId } from '../../stores/taskStore';

/**
 * Global listeners that keep TaskCenter in sync with backend progress events.
 * Mount once near the app root.
 */
export const TaskBridge: React.FC = () => {
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
            (t) => t.kind === 'transfer' && (t.status === 'running' || t.status === 'queued')
          );
          if (!task) {
            const id = makeTaskId('transfer');
            upsertTask({
              id,
              kind: 'transfer',
              title: p.currentFile || 'Transfer',
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
            task = useTaskStore.getState().tasks.find((t) => t.id === id);
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
            (t) =>
              t.kind === 'excel' &&
              (t.backendJobId === p.jobId ||
                ((t.status === 'running' || t.status === 'queued') && !t.backendJobId))
          );
          if (!task) {
            const id = makeTaskId('excel', p.jobId);
            upsertTask({
              id,
              kind: 'excel',
              title: p.message || 'Excel check',
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
            (t) =>
              t.kind === 'analysis' &&
              (t.status === 'running' || t.status === 'queued') &&
              (p.jobId == null || !t.backendJobId || t.backendJobId === p.jobId)
          );
          if (!task) {
            const id = makeTaskId('analysis', p.jobId);
            upsertTask({
              id,
              kind: 'analysis',
              title: p.message || 'Folder analysis',
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
            (t) =>
              t.kind === 'search' &&
              (t.backendJobId === p.jobId ||
                ((t.status === 'running' || t.status === 'queued') && !t.backendJobId))
          );
          if (!task) {
            const id = makeTaskId('search', p.jobId);
            upsertTask({
              id,
              kind: 'search',
              title: p.message || 'Search',
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
    };

    void bind();
    return () => {
      unlisteners.forEach((u) => u());
    };
  }, []);

  return null;
};

export default TaskBridge;
