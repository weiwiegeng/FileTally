import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface PlaceItem {
  id: string;
  path: string;
  label: string;
  connectionId?: string;
  addedAt: number;
}

interface PlacesState {
  favorites: PlaceItem[];
  recent: PlaceItem[];
  addFavorite: (path: string, label?: string, connectionId?: string) => void;
  removeFavorite: (id: string) => void;
  isFavorite: (path: string) => boolean;
  pushRecent: (path: string, label?: string, connectionId?: string) => void;
  clearRecent: () => void;
}

const RECENT_CAP = 30;

const makeId = () => Math.random().toString(36).slice(2, 10);

const labelFromPath = (path: string) => {
  const cleaned = path.replace(/\/+$/, '');
  const parts = cleaned.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || path;
};

export const usePlacesStore = create<PlacesState>()(
  persist(
    (set, get) => ({
      favorites: [],
      recent: [],

      addFavorite: (path, label, connectionId) => {
        if (!path) return;
        if (get().favorites.some((f) => f.path === path)) return;
        set((s) => ({
          favorites: [
            {
              id: makeId(),
              path,
              label: label || labelFromPath(path),
              connectionId,
              addedAt: Date.now(),
            },
            ...s.favorites,
          ],
        }));
      },

      removeFavorite: (id) => {
        set((s) => ({ favorites: s.favorites.filter((f) => f.id !== id) }));
      },

      isFavorite: (path) => get().favorites.some((f) => f.path === path),

      pushRecent: (path, label, connectionId) => {
        if (!path) return;
        set((s) => {
          const rest = s.recent.filter((r) => r.path !== path);
          return {
            recent: [
              {
                id: makeId(),
                path,
                label: label || labelFromPath(path),
                connectionId,
                addedAt: Date.now(),
              },
              ...rest,
            ].slice(0, RECENT_CAP),
          };
        });
      },

      clearRecent: () => set({ recent: [] }),
    }),
    { name: 'filetally-places' }
  )
);
