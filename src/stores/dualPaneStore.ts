import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { normalizeRemotePath } from '../utils/pathNav';

export type BrowserPaneSide = 'left' | 'right';

const normalizeRoot = (path: string | null): string | null => {
  if (!path) return null;
  return path.startsWith('remote://') ? normalizeRemotePath(path) : path;
};

interface DualPaneState {
  leftRoot: string | null;
  rightRoot: string | null;
  activePane: BrowserPaneSide;
  leftSelection: string[];
  rightSelection: string[];
  leftExpandedIds: string[];
  rightExpandedIds: string[];
  leftCwd: string | null;
  rightCwd: string | null;
  leftAnchor: string | null;
  rightAnchor: string | null;
  setLeftRoot: (path: string | null) => void;
  setRightRoot: (path: string | null) => void;
  setActivePane: (pane: BrowserPaneSide) => void;
  setSelection: (pane: BrowserPaneSide, paths: string[]) => void;
  toggleExpanded: (pane: BrowserPaneSide, nodeId: string) => void;
  isExpanded: (pane: BrowserPaneSide, nodeId: string) => boolean;
  setCwd: (pane: BrowserPaneSide, path: string | null) => void;
  setAnchor: (pane: BrowserPaneSide, path: string | null) => void;
  swapPanes: () => void;
}

const expandedFor = (pane: BrowserPaneSide, state: DualPaneState): string[] =>
  pane === 'left' ? state.leftExpandedIds : state.rightExpandedIds;

export const useDualPaneStore = create<DualPaneState>()(
  persist(
    (set, get) => ({
      leftRoot: null,
      rightRoot: null,
      activePane: 'left',
      leftSelection: [],
      rightSelection: [],
      leftExpandedIds: [],
      rightExpandedIds: [],
      leftCwd: null,
      rightCwd: null,
      leftAnchor: null,
      rightAnchor: null,

      setLeftRoot: (path) =>
        set({
          leftRoot: normalizeRoot(path),
          leftSelection: [],
          leftCwd: null,
          leftExpandedIds: [],
        }),
      setRightRoot: (path) =>
        set({
          rightRoot: normalizeRoot(path),
          rightSelection: [],
          rightCwd: null,
          rightExpandedIds: [],
        }),
      setActivePane: (pane) => set({ activePane: pane }),

      setSelection: (pane, paths) => {
        if (pane === 'left') {
          set({ leftSelection: paths });
        } else {
          set({ rightSelection: paths });
        }
      },

      toggleExpanded: (pane, nodeId) => {
        const key = pane === 'left' ? 'leftExpandedIds' : 'rightExpandedIds';
        const cur = get()[key];
        const next = cur.includes(nodeId) ? cur.filter((id) => id !== nodeId) : [...cur, nodeId];
        set({ [key]: next } as Pick<DualPaneState, 'leftExpandedIds' | 'rightExpandedIds'>);
      },

      isExpanded: (pane, nodeId) => expandedFor(pane, get()).includes(nodeId),

      setCwd: (pane, path) => {
        const next = normalizeRoot(path);
        if (pane === 'left') {
          set({ leftCwd: next, leftSelection: [] });
        } else {
          set({ rightCwd: next, rightSelection: [] });
        }
      },

      setAnchor: (pane, path) => {
        if (pane === 'left') {
          set({ leftAnchor: path });
        } else {
          set({ rightAnchor: path });
        }
      },

      swapPanes: () => {
        const s = get();
        set({
          leftRoot: s.rightRoot,
          rightRoot: s.leftRoot,
          leftSelection: s.rightSelection,
          rightSelection: s.leftSelection,
          leftExpandedIds: s.rightExpandedIds,
          rightExpandedIds: s.leftExpandedIds,
          leftCwd: s.rightCwd,
          rightCwd: s.leftCwd,
          leftAnchor: s.rightAnchor,
          rightAnchor: s.leftAnchor,
          activePane: s.activePane === 'left' ? 'right' : 'left',
        });
      },
    }),
    {
      name: 'filetally-dual-pane',
      partialize: (state) => ({
        leftRoot: state.leftRoot,
        rightRoot: state.rightRoot,
        activePane: state.activePane,
        leftCwd: state.leftCwd,
        rightCwd: state.rightCwd,
      }),
      merge: (persisted, current) => {
        const p = (persisted || {}) as Partial<DualPaneState>;
        return {
          ...current,
          ...p,
          leftRoot: normalizeRoot(p.leftRoot ?? null),
          rightRoot: normalizeRoot(p.rightRoot ?? null),
          leftCwd: normalizeRoot(p.leftCwd ?? null),
          rightCwd: normalizeRoot(p.rightCwd ?? null),
        };
      },
    }
  )
);

export const selectionForPane = (pane: BrowserPaneSide, state: DualPaneState): string[] =>
  pane === 'left' ? state.leftSelection : state.rightSelection;

export const rootForPane = (pane: BrowserPaneSide, state: DualPaneState): string | null =>
  pane === 'left' ? state.leftRoot : state.rightRoot;

export const cwdForPane = (pane: BrowserPaneSide, state: DualPaneState): string | null =>
  pane === 'left' ? state.leftCwd : state.rightCwd;

export const anchorForPane = (pane: BrowserPaneSide, state: DualPaneState): string | null =>
  pane === 'left' ? state.leftAnchor : state.rightAnchor;