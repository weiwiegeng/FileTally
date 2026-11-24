import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { mapBackendError } from '../utils/backendError';

export interface PathTag {
  path: string;
  color: string;
  label: string;
}

interface TagState {
  tags: PathTag[];
  loaded: boolean;
  loadTags: () => Promise<void>;
  setTag: (path: string, color: string, label: string) => Promise<void>;
  removeTag: (path: string) => Promise<void>;
  getTagForPath: (path: string) => PathTag | undefined;
}

export const useTagStore = create<TagState>((set, get) => ({
  tags: [],
  loaded: false,

  loadTags: async () => {
    try {
      const tags = await invoke<PathTag[]>('list_path_tags');
      set({ tags, loaded: true });
    } catch (err) {
      console.error('list_path_tags failed:', mapBackendError(err));
      set({ loaded: true });
    }
  },

  setTag: async (path, color, label) => {
    await invoke('set_path_tag', { path, color, label });
    set((s) => {
      const rest = s.tags.filter((t) => t.path !== path);
      return { tags: [...rest, { path, color, label }] };
    });
  },

  removeTag: async (path) => {
    await invoke('remove_path_tag', { path });
    set((s) => ({ tags: s.tags.filter((t) => t.path !== path) }));
  },

  getTagForPath: (path) => get().tags.find((t) => t.path === path),
}));