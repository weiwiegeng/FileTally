import { create } from 'zustand';
import type { BrowserPaneSide } from './dualPaneStore';

export type NavigationMenu =
  | 'disk'
  | 'browser'
  | 'remote'
  | 'filter'
  | 'transfer'
  | 'excel'
  | 'ai'
  | 'tasks'
  | 'rules'
  | 'organize'
  | 'sync'
  | 'trash'
  | 'settings';

export interface PendingBrowserOpen {
  path?: string;
  pane?: BrowserPaneSide;
}

export interface PendingTransferOpen {
  sources: string[];
  target?: string;
}

interface NavigationState {
  requestedMenu: NavigationMenu | null;
  pendingBrowser: PendingBrowserOpen | null;
  pendingTransfer: PendingTransferOpen | null;
  openMenu: (menu: NavigationMenu) => void;
  openBrowserAt: (path?: string, pane?: BrowserPaneSide) => void;
  openTransferWith: (sources: string[], target?: string) => void;
  consumePending: () => {
    menu: NavigationMenu | null;
    browser: PendingBrowserOpen | null;
    transfer: PendingTransferOpen | null;
  };
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
  requestedMenu: null,
  pendingBrowser: null,
  pendingTransfer: null,

  openMenu: (menu) => {
    set({
      requestedMenu: menu,
      pendingBrowser: null,
      pendingTransfer: null,
    });
  },

  openBrowserAt: (path, pane) => {
    set({
      requestedMenu: 'browser',
      pendingBrowser: { path, pane: pane ?? 'left' },
      pendingTransfer: null,
    });
  },

  openTransferWith: (sources, target) => {
    set({
      requestedMenu: 'transfer',
      pendingTransfer: { sources, target },
      pendingBrowser: null,
    });
  },

  consumePending: () => {
    const { requestedMenu, pendingBrowser, pendingTransfer } = get();
    set({
      requestedMenu: null,
      pendingBrowser: null,
      pendingTransfer: null,
    });
    return {
      menu: requestedMenu,
      browser: pendingBrowser,
      transfer: pendingTransfer,
    };
  },
}));