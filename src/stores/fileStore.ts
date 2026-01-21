import { create } from 'zustand';
import { FileNode, FilePreviewInfo, ViewMode, SortField, SortOrder } from '../types';
import { fileService } from '../services';
import { invoke } from '@tauri-apps/api/core';

// Helper function to recursively load all children (with depth limit)
const loadAllChildren = async (
  nodes: FileNode[],
  expandedIds: Set<string>,
  currentDepth: number = 0,
  maxDepth: number = 10
): Promise<FileNode[]> => {
  const result: FileNode[] = [];
  
  for (const node of nodes) {
    if (node.is_dir) {
      expandedIds.add(node.id);
      
      if (currentDepth < maxDepth) {
        try {
          const children = await fileService.scanDirectory(node.path);
          const loadedChildren = await loadAllChildren(
            children,
            expandedIds,
            currentDepth + 1,
            maxDepth
          );
          result.push({
            ...node,
            children: loadedChildren,
            is_loaded: true,
          });
        } catch (error) {
          console.error('Failed to load children for:', node.path);
          result.push({ ...node, children: [], is_loaded: true });
        }
      } else {
        // Beyond max depth, mark as not loaded (lazy load later)
        result.push({ ...node, is_loaded: false });
      }
    } else {
      result.push(node);
    }
  }
  
  return result;
};

// Helper to collect all directory IDs
const collectDirIds = (nodes: FileNode[], ids: Set<string>) => {
  for (const node of nodes) {
    if (node.is_dir) {
      ids.add(node.id);
      if (node.children) {
        collectDirIds(node.children, ids);
      }
    }
  }
};

interface FileState {
  // Current path
  currentPath: string | null;
  // File nodes at current path
  nodes: FileNode[];
  // Selected file for preview
  selectedFile: FileNode | null;
  // Preview info
  previewInfo: FilePreviewInfo | null;
  // UI State
  viewMode: ViewMode;
  sortField: SortField;
  sortOrder: SortOrder;
  showHidden: boolean;
  // Loading states
  loading: boolean;
  previewLoading: boolean;
  error: string | null;
  // Expanded node IDs for tree view
  expandedIds: Set<string>;
  // Actions
  setCurrentPath: (path: string) => Promise<void>;
  pickDirectory: () => Promise<void>;
  loadChildren: (path: string, nodeId: string) => Promise<void>;
  selectFile: (file: FileNode | null) => Promise<void>;
  toggleExpand: (nodeId: string) => void;
  setViewMode: (mode: ViewMode) => void;
  setSortField: (field: SortField) => void;
  setSortOrder: (order: SortOrder) => void;
  toggleShowHidden: () => void;
  // 重命名文件/文件夹
  renameFile: (oldPath: string, newName: string) => Promise<{ success: boolean; error?: string }>;
}

export const useFileStore = create<FileState>((set, get) => ({
  currentPath: null,
  nodes: [],
  selectedFile: null,
  previewInfo: null,
  viewMode: 'tree',
  sortField: 'name',
  sortOrder: 'asc',
  showHidden: false,
  loading: false,
  previewLoading: false,
  error: null,
  expandedIds: new Set(),

  setCurrentPath: async (path: string) => {
    set({ loading: true, error: null, currentPath: path });
    try {
      const nodes = await fileService.scanDirectory(path);
      const expandedIds = new Set<string>();
      
      // Recursively load all children and expand all directories
      const loadedNodes = await loadAllChildren(nodes, expandedIds);
      
      set({ nodes: loadedNodes, loading: false, expandedIds });
    } catch (error) {
      set({ error: String(error), loading: false });
    }
  },

  pickDirectory: async () => {
    try {
      const path = await fileService.pickDirectory();
      if (path) {
        await get().setCurrentPath(path);
      }
    } catch (error) {
      set({ error: String(error) });
    }
  },

  loadChildren: async (path: string, nodeId: string) => {
    try {
      const children = await fileService.scanDirectory(path);
      const updateNodes = (nodes: FileNode[]): FileNode[] => {
        return nodes.map((node) => {
          if (node.id === nodeId) {
            return { ...node, children, is_loaded: true };
          }
          if (node.children) {
            return { ...node, children: updateNodes(node.children) };
          }
          return node;
        });
      };
      set((state) => ({ nodes: updateNodes(state.nodes) }));
    } catch (error) {
      console.error('Failed to load children:', error);
    }
  },

  selectFile: async (file: FileNode | null) => {
    set({ selectedFile: file, previewInfo: null });
    if (file && !file.is_dir) {
      set({ previewLoading: true });
      try {
        const previewInfo = await fileService.getFilePreview(file.path);
        set({ previewInfo, previewLoading: false });
      } catch (error) {
        set({ previewLoading: false });
        console.error('Failed to get preview:', error);
      }
    }
  },

  toggleExpand: (nodeId: string) => {
    set((state) => {
      const newSet = new Set(state.expandedIds);
      if (newSet.has(nodeId)) {
        newSet.delete(nodeId);
      } else {
        newSet.add(nodeId);
      }
      return { expandedIds: newSet };
    });
  },

  setViewMode: (mode: ViewMode) => set({ viewMode: mode }),
  setSortField: (field: SortField) => set({ sortField: field }),
  setSortOrder: (order: SortOrder) => set({ sortOrder: order }),
  toggleShowHidden: () => set((state) => ({ showHidden: !state.showHidden })),

  renameFile: async (oldPath: string, newName: string) => {
    try {
      const result = await invoke<{
        success: boolean;
        newPath: string;
        newName: string;
        error: string | null;
      }>('rename_file', { oldPath, newName });

      if (result.success) {
        // 更新 selectedFile
        const { selectedFile, nodes } = get();
        
        // 递归更新节点路径的辅助函数
        const updateNodePath = (node: FileNode, oldPrefix: string, newPrefix: string): FileNode => {
          const updatedNode = { ...node };
          if (node.path.startsWith(oldPrefix)) {
            updatedNode.path = node.path.replace(oldPrefix, newPrefix);
          }
          if (node.path === oldPath) {
            updatedNode.name = newName;
            updatedNode.path = result.newPath;
          }
          if (node.children) {
            updatedNode.children = node.children.map(child => 
              updateNodePath(child, oldPrefix, newPrefix)
            );
          }
          return updatedNode;
        };

        // 更新文件树
        const updatedNodes = nodes.map(node => 
          updateNodePath(node, oldPath, result.newPath)
        );

        // 更新选中文件
        let updatedSelectedFile = selectedFile;
        if (selectedFile && selectedFile.path === oldPath) {
          updatedSelectedFile = {
            ...selectedFile,
            name: newName,
            path: result.newPath,
          };
        } else if (selectedFile && selectedFile.path.startsWith(oldPath + '/')) {
          // 如果选中的是重命名文件夹的子文件
          updatedSelectedFile = {
            ...selectedFile,
            path: selectedFile.path.replace(oldPath, result.newPath),
          };
        }

        set({ nodes: updatedNodes, selectedFile: updatedSelectedFile });
        return { success: true };
      } else {
        return { success: false, error: result.error || '重命名失败' };
      }
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
}));
