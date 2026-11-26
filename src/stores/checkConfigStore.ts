import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ScopeKind = 'person_folders' | 'flat_files' | 'recursive_files';

export type CheckRule =
  | { type: 'require'; pattern: string }
  | { type: 'flag_contains'; needle: string; label: string };

/** 资料核对方案（可命名保存） */
export interface IntegrityCheckConfig {
  id: string;
  name: string;
  targetFolder: string;
  /** @deprecated prefer rules; kept for migration */
  templates: string[];
  namePattern: string;
  matchMode?: string;
  excelPath?: string;
  matchColumn?: number;
  kind?: 'integrity' | 'match';
  scope?: ScopeKind;
  rules?: CheckRule[];
  presetId?: string;
  createdAt: number;
  updatedAt: number;
}

interface CheckConfigState {
  configs: IntegrityCheckConfig[];
  selectedConfigId: string | null;
  addConfig: (config: Omit<IntegrityCheckConfig, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateConfig: (
    id: string,
    config: Partial<Omit<IntegrityCheckConfig, 'id' | 'createdAt' | 'updatedAt'>>
  ) => void;
  deleteConfig: (id: string) => void;
  selectConfig: (id: string | null) => void;
  getSelectedConfig: () => IntegrityCheckConfig | null;
  getConfigById: (id: string) => IntegrityCheckConfig | undefined;
}

const generateId = () => {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
};

export function templatesToRules(templates: string[]): CheckRule[] {
  return templates.filter(Boolean).map((pattern) => ({ type: 'require' as const, pattern }));
}

export function rulesToTemplates(rules: CheckRule[] | undefined): string[] {
  if (!rules) return [];
  return rules
    .filter((r): r is Extract<CheckRule, { type: 'require' }> => r.type === 'require')
    .map((r) => r.pattern);
}

export const useCheckConfigStore = create<CheckConfigState>()(
  persist(
    (set, get) => ({
      configs: [],
      selectedConfigId: null,

      addConfig: (configData) => {
        const id = generateId();
        const now = Date.now();
        const newConfig: IntegrityCheckConfig = {
          ...configData,
          id,
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({
          configs: [...state.configs, newConfig],
        }));
        return id;
      },

      updateConfig: (id, configData) => {
        set((state) => ({
          configs: state.configs.map((config) =>
            config.id === id
              ? { ...config, ...configData, updatedAt: Date.now() }
              : config
          ),
        }));
      },

      deleteConfig: (id) => {
        set((state) => ({
          configs: state.configs.filter((config) => config.id !== id),
          selectedConfigId: state.selectedConfigId === id ? null : state.selectedConfigId,
        }));
      },

      selectConfig: (id) => {
        set({ selectedConfigId: id });
      },

      getSelectedConfig: () => {
        const state = get();
        if (!state.selectedConfigId) return null;
        return state.configs.find((c) => c.id === state.selectedConfigId) || null;
      },

      getConfigById: (id) => {
        return get().configs.find((c) => c.id === id);
      },
    }),
    {
      name: 'filetally-check-configs',
    }
  )
);
