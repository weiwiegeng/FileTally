import { create } from 'zustand';
import { DiskOverview } from '../types';
import { diskService } from '../services';

interface DiskState {
  diskOverview: DiskOverview | null;
  loading: boolean;
  error: string | null;
  fetchDisks: () => Promise<void>;
  refreshDisks: () => Promise<void>;
}

export const useDiskStore = create<DiskState>((set) => ({
  diskOverview: null,
  loading: false,
  error: null,

  fetchDisks: async () => {
    set({ loading: true, error: null });
    try {
      const overview = await diskService.getDisks();
      set({ diskOverview: overview, loading: false });
    } catch (error) {
      set({ error: String(error), loading: false });
    }
  },

  refreshDisks: async () => {
    set({ loading: true, error: null });
    try {
      const overview = await diskService.refreshDisks();
      set({ diskOverview: overview, loading: false });
    } catch (error) {
      set({ error: String(error), loading: false });
    }
  },
}));
