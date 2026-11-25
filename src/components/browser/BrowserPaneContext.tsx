import React, { createContext, useContext } from 'react';
import type { BrowserPaneSide } from '../../stores';

export interface SelectPathOptions {
  additive?: boolean;
  range?: boolean;
  visiblePaths?: string[];
}

export interface BrowserPaneSelectionConfig {
  pane: BrowserPaneSide;
  selectedPaths: string[];
  onSelectPath: (path: string, opts?: SelectPathOptions) => void;
  enableDrag: boolean;
  previewActive: boolean;
  expandedIds: string[];
  toggleExpand: (nodeId: string) => void;
  cwd: string | null;
  enterFolder: (path: string) => void;
  goUp: () => void;
  setVisiblePaths: (paths: string[]) => void;
}

const BrowserPaneContext = createContext<BrowserPaneSelectionConfig | null>(null);

export const BrowserPaneProvider: React.FC<{
  value: BrowserPaneSelectionConfig;
  children: React.ReactNode;
}> = ({ value, children }) => (
  <BrowserPaneContext.Provider value={value}>{children}</BrowserPaneContext.Provider>
);

export function useBrowserPaneContext(): BrowserPaneSelectionConfig | null {
  return useContext(BrowserPaneContext);
}