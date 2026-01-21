import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

// 传输方向
export type TransferDirection = 'upload' | 'download';

// 传输项目
export interface TransferItem {
  id: string;
  sourcePath: string;
  fileName: string;
  fileType: 'file' | 'folder';
  size: number;
  sizeFormatted: string;
  children?: TransferItem[];  // 文件夹内的子项目
  expanded?: boolean;         // 是否展开
  level?: number;             // 层级深度
}

// 冲突文件信息
export interface ConflictFile {
  sourcePath: string;
  targetPath: string;
  fileName: string;
  sourceSize: number;
  targetSize: number;
  sourceSizeFormatted: string;
  targetSizeFormatted: string;
}

// 冲突处理方式
export type ConflictResolution = 'overwrite' | 'rename' | 'skip';

// 传输进度
export interface TransferProgress {
  currentFile: string;
  currentIndex: number;
  totalFiles: number;
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
}

// 传输结果
export interface TransferResult {
  success: boolean;
  transferred: number;
  skipped: number;
  failed: number;
  errors: string[];
}

// 检查冲突响应
export interface CheckConflictsResponse {
  hasConflicts: boolean;
  conflicts: ConflictFile[];
}

interface TransferState {
  // 传输方向
  direction: TransferDirection;
  
  // 源文件列表
  sourceItems: TransferItem[];
  sourceConnectionName: string | null;  // 下载模式时的远程连接名
  
  // 目标路径
  targetPath: string | null;
  targetConnectionName: string | null;  // 上传模式时的远程连接名
  
  // 传输状态
  loading: boolean;
  transferring: boolean;
  progress: TransferProgress | null;
  result: TransferResult | null;
  error: string | null;
  
  // 冲突处理
  conflicts: ConflictFile[];
  showConflictModal: boolean;
  
  // Actions
  setDirection: (direction: TransferDirection) => void;
  addSourceItems: (items: TransferItem[], connectionName?: string) => void;
  removeSourceItem: (id: string) => void;
  clearSourceItems: () => void;
  setTargetPath: (path: string, connectionName?: string) => void;
  clearTargetPath: () => void;
  
  // 传输操作
  checkConflicts: () => Promise<boolean>;
  startTransfer: (resolution: ConflictResolution) => Promise<void>;
  cancelTransfer: () => void;
  
  // 冲突弹窗
  setShowConflictModal: (show: boolean) => void;
  
  // 重置
  reset: () => void;
  
  // 设置进度
  setProgress: (progress: TransferProgress | null) => void;
}

// 格式化文件大小
const formatSize = (size: number): string => {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  
  if (size >= GB) return `${(size / GB).toFixed(2)} GB`;
  if (size >= MB) return `${(size / MB).toFixed(2)} MB`;
  if (size >= KB) return `${(size / KB).toFixed(2)} KB`;
  return `${size} B`;
};

// 生成唯一 ID
const generateId = () => Math.random().toString(36).substring(2, 15);

export const useTransferStore = create<TransferState>((set, get) => ({
  // 初始状态
  direction: 'upload',
  sourceItems: [],
  sourceConnectionName: null,
  targetPath: null,
  targetConnectionName: null,
  loading: false,
  transferring: false,
  progress: null,
  result: null,
  error: null,
  conflicts: [],
  showConflictModal: false,
  
  setDirection: (direction) => set({
    direction,
    // 切换方向时重置所有状态
    sourceItems: [],
    sourceConnectionName: null,
    targetPath: null,
    targetConnectionName: null,
    result: null,
    error: null,
    conflicts: [],
  }),
  
  addSourceItems: (items, connectionName) => set((state) => ({
    sourceItems: [
      ...state.sourceItems,
      ...items.map(item => ({
        ...item,
        id: generateId(),
        sizeFormatted: item.sizeFormatted || formatSize(item.size),
      })),
    ],
    sourceConnectionName: connectionName || state.sourceConnectionName,
  })),
  
  removeSourceItem: (id) => set((state) => ({
    sourceItems: state.sourceItems.filter(item => item.id !== id),
  })),
  
  clearSourceItems: () => set({ sourceItems: [] }),
  
  setTargetPath: (path, connectionName) => set({
    targetPath: path,
    targetConnectionName: connectionName || null,
  }),
  
  clearTargetPath: () => set({
    targetPath: null,
    targetConnectionName: null,
  }),
  
  checkConflicts: async () => {
    const { sourceItems, targetPath } = get();
    
    if (sourceItems.length === 0 || !targetPath) {
      set({ error: '请选择源文件和目标目录' });
      return false;
    }
    
    set({ loading: true, error: null, conflicts: [] });
    
    try {
      const sourcePaths = sourceItems.map(item => item.sourcePath);
      const response = await invoke<CheckConflictsResponse>('check_transfer_conflicts', {
        sourcePaths,
        targetPath,
      });
      
      if (response.hasConflicts) {
        set({
          conflicts: response.conflicts,
          showConflictModal: true,
          loading: false,
        });
        return true;
      }
      
      set({ loading: false });
      return false;
    } catch (err) {
      set({ error: String(err), loading: false });
      return false;
    }
  },
  
  startTransfer: async (resolution) => {
    const { sourceItems, targetPath } = get();
    
    if (sourceItems.length === 0 || !targetPath) {
      set({ error: '请选择源文件和目标目录' });
      return;
    }
    
    set({
      transferring: true,
      error: null,
      result: null,
      showConflictModal: false,
      progress: {
        currentFile: '',
        currentIndex: 0,
        totalFiles: sourceItems.length,
        bytesTransferred: 0,
        totalBytes: sourceItems.reduce((sum, item) => sum + item.size, 0),
        percentage: 0,
      },
    });
    
    try {
      const sourcePaths = sourceItems.map(item => item.sourcePath);
      const result = await invoke<TransferResult>('transfer_files', {
        sourcePaths,
        targetPath,
        conflictResolution: resolution,
      });
      
      set({
        result,
        transferring: false,
        progress: null,
      });
      
      // 传输成功后清空源文件列表
      if (result.success) {
        set({ sourceItems: [] });
      }
    } catch (err) {
      set({
        error: String(err),
        transferring: false,
        progress: null,
      });
    }
  },
  
  cancelTransfer: () => {
    // TODO: 实现取消传输逻辑
    set({ transferring: false, progress: null });
  },
  
  setShowConflictModal: (show) => set({ showConflictModal: show }),
  
  reset: () => set({
    direction: 'upload',
    sourceItems: [],
    sourceConnectionName: null,
    targetPath: null,
    targetConnectionName: null,
    loading: false,
    transferring: false,
    progress: null,
    result: null,
    error: null,
    conflicts: [],
    showConflictModal: false,
  }),
  
  setProgress: (progress) => set({ progress }),
}));
