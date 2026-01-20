import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { FileNode, FilePreviewInfo } from '../types';

export const fileService = {
  /**
   * Scan a directory and return first-level children
   */
  async scanDirectory(path: string): Promise<FileNode[]> {
    return invoke<FileNode[]>('scan_directory', { path });
  },

  /**
   * Get file preview information
   */
  async getFilePreview(path: string): Promise<FilePreviewInfo> {
    return invoke<FilePreviewInfo>('get_file_preview', { path });
  },

  /**
   * Get home directory path
   */
  async getHomeDir(): Promise<string> {
    return invoke<string>('get_home_dir');
  },

  /**
   * Open directory picker dialog
   */
  async pickDirectory(): Promise<string | null> {
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择文件夹',
    });
    return selected as string | null;
  },
};
