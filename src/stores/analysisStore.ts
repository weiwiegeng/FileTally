import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { mapBackendError } from '../utils/backendError';
import { makeTaskId, useTaskStore } from './taskStore';

// 文件类型统计
export interface FileTypeStats {
  extension: string;
  count: number;
  totalSize: number;
}

// 大文件信息
export interface LargeFile {
  path: string;
  name: string;
  size: number;
  sizeFormatted: string;
  modifiedTime: number;
}

// 重复文件组
export interface DuplicateGroup {
  hash: string;
  size: number;
  sizeFormatted: string;
  files: string[];
}

// 旧文件信息
export interface OldFile {
  path: string;
  name: string;
  size: number;
  sizeFormatted: string;
  lastModifiedDays: number;
  /** @deprecated kept for older cached payloads */
  lastAccessedDays?: number;
  modifiedTime: number;
}

// 文件夹分析结果
export interface FolderAnalysisResult {
  path: string;
  totalFiles: number;
  totalDirs: number;
  totalSize: number;
  totalSizeFormatted: string;
  fileTypeStats: FileTypeStats[];
  largeFiles: LargeFile[];
  duplicateGroups: DuplicateGroup[];
  oldFiles: OldFile[];
  analyzedAt: number;
  truncated?: boolean;
}

// 清理项
export interface CleanupItem {
  category: string;
  path: string;
  name: string;
  size: number;
  sizeFormatted: string;
  description: string;
}

// 清理建议结果
export interface CleanupSuggestion {
  cacheFiles: CleanupItem[];
  tempFiles: CleanupItem[];
  downloadFiles: CleanupItem[];
  logFiles: CleanupItem[];
  totalCleanableSize: number;
  totalCleanableSizeFormatted: string;
  analyzedAt: number;
}

interface AnalysisState {
  // 文件夹分析
  folderAnalysis: FolderAnalysisResult | null;
  folderAnalysisLoading: boolean;
  folderAnalysisPath: string;
  
  // 清理建议
  cleanupSuggestion: CleanupSuggestion | null;
  cleanupLoading: boolean;
  
  // 当前Tab
  activeTab: 'folder' | 'cleanup' | 'document';
  
  // Actions
  setActiveTab: (tab: 'folder' | 'cleanup' | 'document') => void;
  setFolderAnalysisPath: (path: string) => void;
  analyzeFolderStart: () => void;
  analyzeFolderSuccess: (result: FolderAnalysisResult) => void;
  analyzeFolderError: () => void;
  scanCleanupStart: () => void;
  scanCleanupSuccess: (result: CleanupSuggestion) => void;
  scanCleanupError: () => void;
  clearFolderAnalysis: () => void;
  clearCleanupSuggestion: () => void;
  runFolderAnalysis: () => Promise<void>;
}

export const useAnalysisStore = create<AnalysisState>((set, get) => ({
  folderAnalysis: null,
  folderAnalysisLoading: false,
  folderAnalysisPath: '',
  cleanupSuggestion: null,
  cleanupLoading: false,
  activeTab: 'folder',
  
  setActiveTab: (tab) => set({ activeTab: tab }),
  
  setFolderAnalysisPath: (path) => set({ folderAnalysisPath: path }),
  
  analyzeFolderStart: () => set({ folderAnalysisLoading: true }),
  
  analyzeFolderSuccess: (result) => set({
    folderAnalysis: result,
    folderAnalysisLoading: false,
  }),
  
  analyzeFolderError: () => set({ folderAnalysisLoading: false }),
  
  scanCleanupStart: () => set({ cleanupLoading: true }),
  
  scanCleanupSuccess: (result) => set({
    cleanupSuggestion: result,
    cleanupLoading: false,
  }),
  
  scanCleanupError: () => set({ cleanupLoading: false }),
  
  clearFolderAnalysis: () => set({ folderAnalysis: null, folderAnalysisPath: '' }),
  
  clearCleanupSuggestion: () => set({ cleanupSuggestion: null }),

  runFolderAnalysis: async () => {
    const path = get().folderAnalysisPath;
    if (!path) return;

    const retryPayload = { action: 'analyzeFolder' as const, path };
    set({ folderAnalysisLoading: true });

    let taskId = '';
    let jobId = 0;
    try {
      jobId = await invoke<number>('prepare_analysis');
      taskId = makeTaskId('analysis', jobId);
      useTaskStore.getState().upsertTask({
        id: taskId,
        kind: 'analysis',
        title: path,
        status: 'running',
        backendJobId: jobId,
        progress: { current: 0, total: 0, percentage: 0 },
        startedAt: Date.now(),
        cancellable: true,
        retryPayload,
      });

      const result = await invoke<FolderAnalysisResult>('analyze_folder', {
        path,
        largeFileThresholdMb: 100,
        oldFileDays: 180,
        jobId,
      });

      set({
        folderAnalysis: result,
        folderAnalysisLoading: false,
      });
      useTaskStore.getState().completeTask(taskId, 'completed', undefined, retryPayload);
    } catch (err) {
      set({ folderAnalysisLoading: false });
      if (taskId) {
        useTaskStore
          .getState()
          .completeTask(taskId, 'failed', mapBackendError(err), retryPayload);
      }
      throw err;
    }
  },
}));
