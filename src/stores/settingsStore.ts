import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { SortField, SortOrder } from '../types';
import { normalizeSortField } from '../utils/sortFiles';

// AI 模型提供商类型
export type AIProvider =
  | 'openai'
  | 'claude'
  | 'ollama'
  | 'custom'
  | 'deepseek'
  | 'zhipu'
  | 'qwen'
  | 'kimi'
  | 'hunyuan';

/** What the selected model is expected to handle. */
export type AICapability = 'text' | 'vision' | 'multimodal';

// AI 配置
export interface AIConfig {
  provider: AIProvider;
  apiKey: string;
  apiEndpoint: string;
  model: string;
  maxTokens: number;
  temperature: number;
  /** text = chat only; vision/multimodal = may accept images later */
  capability: AICapability;
}

export type DefaultPage = 'disk' | 'browser' | 'filter' | 'remote' | 'transfer' | 'excel' | 'ai' | 'settings';

export interface AppSettings {
  // 通用设置
  language: 'zh-CN' | 'en-US';
  theme: 'dark' | 'light' | 'system';
  defaultPage: DefaultPage;
  
  // 文件浏览设置
  showHiddenFiles: boolean;
  defaultExpandLevel: number;       // 默认展开层级
  sortBy: SortField;
  sortOrder: SortOrder;
  previewPanelPosition: 'right' | 'bottom';
  /** Side-by-side local/remote panes in file browser */
  dualPaneBrowser: boolean;
  
  // 搜索设置
  defaultSearchContent: boolean;
  defaultSearchFilename: boolean;
  defaultCaseSensitive: boolean;
  maxPdfSizeMB: number;            // PDF 最大处理大小 (MB)
  maxTextSizeMB: number;           // 文本最大读取大小 (MB)
  searchTimeout: number;           // 搜索超时 (秒)
  
  // 性能设置
  maxConcurrentSearches: number;   // 最大并发搜索数
  enableSearchCache: boolean;
  /** Transfer bandwidth cap in MB/s; 0 = unlimited */
  transferBandwidthMBps: number;
  /** Transfer queue concurrency (1–2) */
  transferConcurrency: number;
  
  // AI 设置
  aiConfig: AIConfig;
}

interface SettingsState {
  settings: AppSettings;
  updateSettings: (updates: Partial<AppSettings>) => void;
  resetSettings: () => void;
}

const defaultSettings: AppSettings = {
  // 通用设置
  language: 'zh-CN',
  theme: 'dark',
  defaultPage: 'disk',
  
  // 文件浏览设置
  showHiddenFiles: false,
  defaultExpandLevel: 1,
  sortBy: 'name',
  sortOrder: 'asc',
  previewPanelPosition: 'right',
  dualPaneBrowser: true,
  
  // 搜索设置
  defaultSearchContent: true,
  defaultSearchFilename: true,
  defaultCaseSensitive: false,
  maxPdfSizeMB: 30,
  maxTextSizeMB: 10,
  searchTimeout: 60,
  
  // 性能设置
  maxConcurrentSearches: 4,
  enableSearchCache: true,
  transferBandwidthMBps: 0,
  transferConcurrency: 1,
  
  // AI 设置
  aiConfig: {
    provider: 'openai',
    apiKey: '',
    apiEndpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    maxTokens: 4096,
    temperature: 0.7,
    capability: 'multimodal',
  },
};

const normalizeDefaultPage = (value: string | undefined): DefaultPage => {
  if (value === 'search') return 'filter';
  const allowed: DefaultPage[] = ['disk', 'browser', 'filter', 'remote', 'transfer', 'excel', 'ai', 'settings'];
  if (value && (allowed as string[]).includes(value)) {
    return value as DefaultPage;
  }
  return 'disk';
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      settings: defaultSettings,
      
      updateSettings: (updates) => {
        set((state) => ({
          settings: { ...state.settings, ...updates },
        }));
      },
      
      resetSettings: () => {
        set({ settings: defaultSettings });
      },
    }),
    {
      name: 'filetally-settings',
      // 处理旧版本数据迁移，确保新字段有默认值
      merge: (persistedState: any, currentState) => {
        const persisted = persistedState as SettingsState;
        const raw = persisted?.settings || {};
        return {
          ...currentState,
          settings: {
            ...defaultSettings,
            ...raw,
            defaultPage: normalizeDefaultPage(raw.defaultPage),
            sortBy: normalizeSortField(raw.sortBy || defaultSettings.sortBy),
            // 确保 aiConfig 存在且完整
            aiConfig: {
              ...defaultSettings.aiConfig,
              ...raw.aiConfig,
              capability:
                raw.aiConfig?.capability ||
                defaultSettings.aiConfig.capability,
            },
          },
        };
      },
    }
  )
);
