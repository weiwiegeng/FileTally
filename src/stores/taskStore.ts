import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';

export type TaskKind = 'search' | 'transfer' | 'excel' | 'analysis' | 'sync' | 'rules' | 'organize' | 'index';
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface TaskProgress {
  current: number;
  total: number;
  percentage: number;
  message?: string;
  stage?: string;
}

export interface AppTask {
  id: string;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  progress: TaskProgress;
  backendJobId?: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  cancellable: boolean;
  /** Opaque retry payload for the originating module */
  retryPayload?: Record<string, unknown>;
}

interface TaskState {
  tasks: AppTask[];
  upsertTask: (task: AppTask) => void;
  updateTask: (id: string, patch: Partial<AppTask>) => void;
  updateProgress: (id: string, progress: Partial<TaskProgress> & { status?: TaskStatus }) => void;
  completeTask: (
    id: string,
    status?: TaskStatus,
    error?: string,
    retryPayload?: Record<string, unknown>
  ) => void;
  cancelTask: (id: string) => Promise<void>;
  clearFinished: () => void;
  removeTask: (id: string) => void;
  getActiveCount: () => number;
}

const HISTORY_CAP = 80;

const cancelBackend = async (kind: TaskKind, jobId?: number) => {
  if (!jobId || jobId <= 0) return;
  const cmd =
    kind === 'search'
      ? 'cancel_search'
      : kind === 'transfer'
        ? 'cancel_transfer'
        : kind === 'sync'
          ? 'cancel_sync'
          : kind === 'excel'
            ? 'cancel_excel_check'
            : kind === 'analysis'
              ? 'cancel_analysis'
              : kind === 'rules'
                ? 'cancel_rule_filter'
                : null;
  if (!cmd) return;
  try {
    await invoke(cmd, { jobId });
  } catch {
    // ignore
  }
};

export const useTaskStore = create<TaskState>()(
  persist(
    (set, get) => ({
      tasks: [],

      upsertTask: (task) => {
        set((state) => {
          const idx = state.tasks.findIndex((t) => t.id === task.id);
          let tasks: AppTask[];
          if (idx >= 0) {
            tasks = [...state.tasks];
            tasks[idx] = { ...tasks[idx], ...task };
          } else {
            tasks = [task, ...state.tasks];
          }
          if (tasks.length > HISTORY_CAP) {
            const active = tasks.filter((t) => t.status === 'running' || t.status === 'queued');
            const rest = tasks.filter((t) => t.status !== 'running' && t.status !== 'queued').slice(0, HISTORY_CAP - active.length);
            tasks = [...active, ...rest];
          }
          return { tasks };
        });
      },

      updateTask: (id, patch) => {
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        }));
      },

      updateProgress: (id, progress) => {
        set((state) => ({
          tasks: state.tasks.map((t) => {
            if (t.id !== id) return t;
            const nextProgress = { ...t.progress, ...progress };
            const total = progress.total ?? nextProgress.total;
            const current = progress.current ?? nextProgress.current;
            if (total > 0) {
              nextProgress.percentage = Math.min(100, Math.round((current / total) * 100));
            }
            return {
              ...t,
              status: progress.status || t.status,
              progress: nextProgress,
            };
          }),
        }));
      },

      completeTask: (id, status = 'completed', error, retryPayload) => {
        set((state) => ({
          tasks: state.tasks.map((t) =>
            t.id === id
              ? {
                  ...t,
                  status,
                  error,
                  retryPayload: retryPayload !== undefined ? retryPayload : t.retryPayload,
                  finishedAt: Date.now(),
                  progress: {
                    ...t.progress,
                    percentage: status === 'completed' ? 100 : t.progress.percentage,
                  },
                }
              : t
          ),
        }));
      },

      cancelTask: async (id) => {
        const task = get().tasks.find((t) => t.id === id);
        if (!task || (task.status !== 'running' && task.status !== 'queued')) return;
        get().updateTask(id, { status: 'cancelled' });
        await cancelBackend(task.kind, task.backendJobId);
        get().completeTask(id, 'cancelled');
      },

      clearFinished: () => {
        set((state) => ({
          tasks: state.tasks.filter(
            (t) => t.status === 'running' || t.status === 'queued'
          ),
        }));
      },

      removeTask: (id) => {
        set((state) => ({ tasks: state.tasks.filter((t) => t.id !== id) }));
      },

      getActiveCount: () =>
        get().tasks.filter((t) => t.status === 'running' || t.status === 'queued').length,
    }),
    {
      name: 'filetally-tasks',
      partialize: (state) => ({
        tasks: state.tasks
          .filter((t) => t.status !== 'running' && t.status !== 'queued')
          .slice(0, HISTORY_CAP),
      }),
    }
  )
);

export const makeTaskId = (kind: TaskKind, backendJobId?: number) =>
  `${kind}-${backendJobId || Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
