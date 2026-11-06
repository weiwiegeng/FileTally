import { create } from 'zustand';
import { FileNode, FilePreviewInfo, ViewMode, SortField, SortOrder } from '../types';
import { fileService } from '../services';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from './settingsStore';
import i18n from '../i18n';
import { mapBackendError } from '../utils/backendError';

/** 按设置的默认展开层级预加载并展开目录 */
const expandToLevel = async (
  nodes: FileNode[],
  expandedIds: Set<string>,
  currentDepth: number,
  maxDepth: number
): Promise<FileNode[]> => {
  if (maxDepth <= 0) return nodes;

  const result: FileNode[] = [];
  for (const node of nodes) {
    if (node.is_dir && currentDepth < maxDepth) {
      expandedIds.add(node.id);
      try {
        const children = await fileService.scanDirectory(node.path);
        const loadedChildren = await expandToLevel(
          children.map((child) => ({ ...child, is_loaded: child.is_dir ? false : true })),
          expandedIds,
          currentDepth + 1,
          maxDepth
        );
        result.push({
          ...node,
          children: loadedChildren,
          is_loaded: true,
        });
      } catch {
        result.push({ ...node, children: [], is_loaded: true });
      }
    } else {
      result.push(node);
    }
  }
  return result;
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
  openHomeDirectory: () => Promise<void>;
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
      const expandLevel = Math.max(0, useSettingsStore.getState().settings.defaultExpandLevel - 1);
      const expandedIds = new Set<string>();

      // Parallel load all paths，并按默认展开层级预加载
      const results = await Promise.all(
        paths.map(async (path) => {
          try {
            const nodes = await fileService.scanDirectory(path);
            const baseNodes = nodes.map(node => ({ ...node, is_loaded: node.is_dir ? false : true }));
            const loadedNodes = await expandToLevel(baseNodes, expandedIds, 0, expandLevel);
            return { path, nodes: loadedNodes, success: true as const, error: null as string | null };
          } catch (error) {
            console.error('Failed to load path:', path, error);
            return { path, nodes: [], success: false as const, error: mapBackendError(error) };
          }
        })
      );

      const nodesMap: Record<string, FileNode[]> = {};
      results.forEach(({ path, nodes }) => {
        nodesMap[path] = nodes;
      });

      const failures = results.filter((r) => !r.success);
      const partialError =
        failures.length === 0
          ? null
          : failures.length === paths.length
            ? failures.map((f) => f.error).filter(Boolean).join('; ')
            : i18n.t('errors.paths_load_partial', {
                detail: failures.map((f) => `${f.path}: ${f.error}`).join('; '),
              });

      set({ nodesMap, loading: false, error: partialError, expandedIds, loadingPaths: new Set() });
    } catch (error) {
      set({ error: mapBackendError(error), loading: false, loadingPaths: new Set() });
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
        const newNodesMap = { ...state.nodesMap };
        delete newNodesMap[path];
        return {
          currentPaths: state.currentPaths.filter((p) => p !== path),
          nodesMap: newNodesMap,
          error: mapBackendError(error),
          loadingPaths: newLoadingPaths,
        };
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
      set({ error: mapBackendError(error) });
    }
  },

  openHomeDirectory: async () => {
    try {
      const home = await fileService.getHomeDir();
      if (home) {
        await get().addPath(home);
      }
    } catch (error) {
      set({ error: mapBackendError(error) });
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
    const requestPath = file?.path ?? null;
    set({ selectedFile: file, previewInfo: null });
    
    if (!file) return;
    
    if (file.is_dir) {
      // 如果是文件夹且子内容未加载，加载子内容用于预览
      if (!file.children || file.children.length === 0) {
        set({ previewLoading: true });
        try {
          const children = await fileService.scanDirectory(file.path);
          // 忽略过期请求
          if (get().selectedFile?.path !== requestPath) return;
          const updatedFile = { ...file, children, is_loaded: true };
          set({ selectedFile: updatedFile, previewLoading: false });
        } catch (error) {
          if (get().selectedFile?.path !== requestPath) return;
          set({ previewLoading: false, error: mapBackendError(error) });
          console.error('Failed to load folder contents:', error);
        }
      }
    } else {
      // 文件预览
      set({ previewLoading: true });
      try {
        const previewInfo = await fileService.getFilePreview(file.path);
        if (get().selectedFile?.path !== requestPath) return;
        set({ previewInfo, previewLoading: false });
      } catch (error) {
        if (get().selectedFile?.path !== requestPath) return;
        set({ previewLoading: false, error: mapBackendError(error) });
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
        
        // Bound prefix: `/a/test` must not rewrite sibling `/a/test2`
        const pathUnder = (path: string, prefix: string) =>
          path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '\\');

        const updateNodePath = (node: FileNode, oldPrefix: string, newPrefix: string): FileNode => {
          const updatedNode = { ...node };
          if (node.path === oldPath) {
            updatedNode.name = newName;
            updatedNode.path = result.newPath;
          } else if (pathUnder(node.path, oldPrefix)) {
            updatedNode.path = newPrefix + node.path.slice(oldPrefix.length);
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
        } else if (selectedFile && pathUnder(selectedFile.path, oldPath)) {
          // 选中的是重命名文件夹的子文件 — 与 nodesMap 相同的边界前缀拼接
          updatedSelectedFile = {
            ...selectedFile,
            path: result.newPath + selectedFile.path.slice(oldPath.length),
          };
        }

        set({ nodesMap: updatedNodesMap, selectedFile: updatedSelectedFile });
        return { success: true };
      } else {
        return { success: false, error: result.error || i18n.t('browser.fileTreeNode.renameFailed') };
      }
    } catch (error) {
      return { success: false, error: mapBackendError(error) };
    }
  },
}));
