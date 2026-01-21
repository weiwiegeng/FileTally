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
  // Current paths (support multiple)
  currentPaths: string[];
  // File nodes map by root path
  nodesMap: Record<string, FileNode[]>;
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
  // Loading paths
  loadingPaths: Set<string>;
  // Expanded node IDs for tree view
  expandedIds: Set<string>;
  // Actions
  setCurrentPaths: (paths: string[]) => Promise<void>;
  addPath: (path: string) => Promise<void>;
  removePath: (path: string) => void;
  clearPaths: () => void;
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
  // Compatibility: get first path as currentPath
  currentPath: string | null;
  nodes: FileNode[];
}

export const useFileStore = create<FileState>((set, get) => ({
  currentPaths: [],
  nodesMap: {},
  selectedFile: null,
  previewInfo: null,
  viewMode: 'tree',
  sortField: 'name',
  sortOrder: 'asc',
  showHidden: false,
  loading: false,
  previewLoading: false,
  error: null,
  loadingPaths: new Set(),
  expandedIds: new Set(),

  // Compatibility getters
  get currentPath() {
    return get().currentPaths[0] || null;
  },
  get nodes() {
    const { currentPaths, nodesMap } = get();
    if (currentPaths.length === 0) return [];
    // Return all nodes from all paths flattened
    return currentPaths.flatMap(p => nodesMap[p] || []);
  },

  setCurrentPaths: async (paths: string[]) => {
    if (paths.length === 0) {
      set({ currentPaths: [], nodesMap: {}, loading: false, error: null, selectedFile: null, previewInfo: null, expandedIds: new Set() });
      return;
    }

    set({ loading: true, error: null, currentPaths: paths, loadingPaths: new Set(paths), selectedFile: null, previewInfo: null });
    
    try {
      // Parallel load all paths - only first level, collapsed by default
      const results = await Promise.all(
        paths.map(async (path) => {
          try {
            const nodes = await fileService.scanDirectory(path);
            // Mark all nodes as loaded but don't expand
            const loadedNodes = nodes.map(node => ({ ...node, is_loaded: node.is_dir ? false : true }));
            return { path, nodes: loadedNodes, success: true };
          } catch (error) {
            console.error('Failed to load path:', path, error);
            return { path, nodes: [], success: false };
          }
        })
      );

      // Build nodesMap - no expanded IDs (collapsed by default)
      const nodesMap: Record<string, FileNode[]> = {};
      results.forEach(({ path, nodes }) => {
        nodesMap[path] = nodes;
      });

      set({ nodesMap, loading: false, expandedIds: new Set(), loadingPaths: new Set() });
    } catch (error) {
      set({ error: String(error), loading: false, loadingPaths: new Set() });
    }
  },

  addPath: async (path: string) => {
    const { currentPaths } = get();
    if (currentPaths.includes(path)) return;

    set(state => ({ 
      currentPaths: [...state.currentPaths, path],
      loadingPaths: new Set(state.loadingPaths).add(path)
    }));

    try {
      const nodes = await fileService.scanDirectory(path);
      // Only load first level, collapsed by default
      const loadedNodes = nodes.map(node => ({ ...node, is_loaded: node.is_dir ? false : true }));

      set(state => {
        const newLoadingPaths = new Set(state.loadingPaths);
        newLoadingPaths.delete(path);
        return {
          nodesMap: { ...state.nodesMap, [path]: loadedNodes },
          loadingPaths: newLoadingPaths,
        };
      });
    } catch (error) {
      set(state => {
        const newLoadingPaths = new Set(state.loadingPaths);
        newLoadingPaths.delete(path);
        return { error: String(error), loadingPaths: newLoadingPaths };
      });
    }
  },

  removePath: (path: string) => {
    set(state => {
      const newPaths = state.currentPaths.filter(p => p !== path);
      const newNodesMap = { ...state.nodesMap };
      delete newNodesMap[path];
      
      // 如果没有剩余路径，或者选中的文件属于被移除的路径，清空选中状态
      const shouldClearSelection = newPaths.length === 0 || 
        (state.selectedFile && state.selectedFile.path.startsWith(path));
      
      return { 
        currentPaths: newPaths, 
        nodesMap: newNodesMap,
        ...(shouldClearSelection ? { selectedFile: null, previewInfo: null } : {})
      };
    });
  },

  clearPaths: () => {
    set({ currentPaths: [], nodesMap: {}, selectedFile: null, previewInfo: null, expandedIds: new Set() });
  },

  pickDirectory: async () => {
    try {
      const selected = await fileService.pickDirectoryMultiple();
      if (selected && selected.length > 0) {
        await get().setCurrentPaths(selected);
      }
    } catch (error) {
      set({ error: String(error) });
    }
  },

  loadChildren: async (path: string, nodeId: string) => {
    try {
      const children = await fileService.scanDirectory(path);
      // Mark children as not loaded (collapsed)
      const loadedChildren = children.map(node => ({ ...node, is_loaded: node.is_dir ? false : true }));
      
      const updateNodes = (nodes: FileNode[]): FileNode[] => {
        return nodes.map((node) => {
          if (node.id === nodeId) {
            return { ...node, children: loadedChildren, is_loaded: true };
          }
          if (node.children) {
            return { ...node, children: updateNodes(node.children) };
          }
          return node;
        });
      };
      
      // Update nodesMap
      set((state) => {
        const newNodesMap: Record<string, FileNode[]> = {};
        Object.entries(state.nodesMap).forEach(([rootPath, nodes]) => {
          newNodesMap[rootPath] = updateNodes(nodes);
        });
        return { nodesMap: newNodesMap };
      });
    } catch (error) {
      console.error('Failed to load children:', error);
    }
  },

  selectFile: async (file: FileNode | null) => {
    set({ selectedFile: file, previewInfo: null });
    
    if (!file) return;
    
    if (file.is_dir) {
      // 如果是文件夹且子内容未加载，加载子内容用于预览
      if (!file.children || file.children.length === 0) {
        set({ previewLoading: true });
        try {
          const children = await fileService.scanDirectory(file.path);
          // 更新 selectedFile 的 children
          const updatedFile = { ...file, children, is_loaded: true };
          set({ selectedFile: updatedFile, previewLoading: false });
        } catch (error) {
          set({ previewLoading: false });
          console.error('Failed to load folder contents:', error);
        }
      }
    } else {
      // 文件预览
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
        // 获取当前状态
        const { selectedFile, nodesMap } = get();
        
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

        // 更新 nodesMap
        const updatedNodesMap: Record<string, FileNode[]> = {};
        Object.entries(nodesMap).forEach(([rootPath, nodes]) => {
          updatedNodesMap[rootPath] = nodes.map(node => 
            updateNodePath(node, oldPath, result.newPath)
          );
        });

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

        set({ nodesMap: updatedNodesMap, selectedFile: updatedSelectedFile });
        return { success: true };
      } else {
        return { success: false, error: result.error || '重命名失败' };
      }
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
}));
