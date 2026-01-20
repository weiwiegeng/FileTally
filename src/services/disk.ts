import { invoke } from '@tauri-apps/api/core';
import { DiskOverview } from '../types';

export const diskService = {
  /**
   * Get all disk information
   */
  async getDisks(): Promise<DiskOverview> {
    return invoke<DiskOverview>('get_disks');
  },

  /**
   * Refresh disk information
   */
  async refreshDisks(): Promise<DiskOverview> {
    return invoke<DiskOverview>('refresh_disks');
  },
};
