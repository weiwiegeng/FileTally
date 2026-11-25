import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SyncMode = 'one_way' | 'two_way';
export type SyncConflictResolution = 'skip' | 'prefer_source' | 'prefer_dest';

export interface SyncPreset {
  id: string;
  name: string;
  source: string;
  dest: string;
  mode: SyncMode;
  conflictResolution: SyncConflictResolution;
  deleteExtras: boolean;
  /** Minutes between scheduled compare+run while app is open; 0 = off */
  intervalMinutes: number;
  createdAt: number;
  lastRunAt?: number;
  lastRunOk?: boolean;
  lastError?: string;
}

interface SyncPresetsState {
  presets: SyncPreset[];
  addPreset: (
    name: string,
    source: string,
    dest: string,
    mode?: SyncMode,
    conflictResolution?: SyncConflictResolution,
    intervalMinutes?: number,
    deleteExtras?: boolean
  ) => void;
  updatePreset: (id: string, patch: Partial<Omit<SyncPreset, 'id'>>) => void;
  removePreset: (id: string) => void;
  listPresets: () => SyncPreset[];
}

const makeId = () => Math.random().toString(36).slice(2, 10);

export const useSyncPresetsStore = create<SyncPresetsState>()(
  persist(
    (set, get) => ({
      presets: [],

      addPreset: (
        name,
        source,
        dest,
        mode = 'one_way',
        conflictResolution = 'skip',
        intervalMinutes = 0,
        deleteExtras = false
      ) => {
        const trimmed = name.trim();
        if (!trimmed || !source.trim() || !dest.trim()) return;
        set((s) => ({
          presets: [
            {
              id: makeId(),
              name: trimmed,
              source: source.trim(),
              dest: dest.trim(),
              mode,
              conflictResolution,
              deleteExtras,
              intervalMinutes: Math.max(0, intervalMinutes || 0),
              createdAt: Date.now(),
            },
            ...s.presets,
          ],
        }));
      },

      updatePreset: (id, patch) => {
        set((s) => ({
          presets: s.presets.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        }));
      },

      removePreset: (id) => {
        set((s) => ({ presets: s.presets.filter((p) => p.id !== id) }));
      },

      listPresets: () => get().presets,
    }),
    { name: 'filetally-sync-presets' }
  )
);