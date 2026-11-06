import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import i18n from '../i18n';
import { mapBackendError } from '../utils/backendError';

export interface RemoteConnection {
  id: string;
  name: string;
  type: 'smb' | 'nfs' | 'ftp';
  host: string;
  port?: number;
  share: string;          // SMB 共享名
  username?: string;
  password?: string;
  mountPoint?: string;    // 挂载点
  lastConnected?: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
}

interface RemoteState {
  // 连接列表
  connections: RemoteConnection[];
  // 当前选中的连接
  activeConnectionId: string | null;
  // 连接中状态
  connecting: boolean;
  
  // Actions
  addConnection: (conn: Omit<RemoteConnection, 'id' | 'status'>) => void;
  updateConnection: (id: string, updates: Partial<RemoteConnection>) => void;
  removeConnection: (id: string) => void;
  setActiveConnection: (id: string | null) => void;
  connect: (id: string) => Promise<boolean>;
  disconnect: (id: string) => Promise<void>;
  getConnection: (id: string) => RemoteConnection | undefined;
}

// 生成唯一 ID
const generateId = () => Math.random().toString(36).substring(2, 15);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const buildMountCandidates = (conn: RemoteConnection): string[] => {
  const candidates = new Set<string>();
  if (conn.share) {
    candidates.add(`/Volumes/${conn.share}`);
  }
  if (conn.name) {
    candidates.add(`/Volumes/${conn.name}`);
  }
  return Array.from(candidates);
};

export const useRemoteStore = create<RemoteState>()(
  persist(
    (set, get) => ({
      connections: [],
      activeConnectionId: null,
      connecting: false,
      
      addConnection: (conn) => {
        const newConnection: RemoteConnection = {
          ...conn,
          id: generateId(),
          status: 'disconnected',
        };
        set((state) => ({
          connections: [...state.connections, newConnection],
        }));
      },
      
      updateConnection: (id, updates) => {
        set((state) => ({
          connections: state.connections.map((c) =>
            c.id === id ? { ...c, ...updates } : c
          ),
        }));
      },
      
      removeConnection: (id) => {
        set((state) => ({
          connections: state.connections.filter((c) => c.id !== id),
          activeConnectionId: state.activeConnectionId === id ? null : state.activeConnectionId,
        }));
      },
      
      setActiveConnection: (id) => {
        set({ activeConnectionId: id });
      },
      
      getConnection: (id) => {
        return get().connections.find((c) => c.id === id);
      },
      
      connect: async (id) => {
        const { updateConnection, connecting } = get();
        const conn = get().connections.find((c) => c.id === id);
        
        if (!conn) return false;

        if (connecting) {
          return false;
        }

        if (conn.type !== 'smb') {
          updateConnection(id, {
            status: 'error',
            error: i18n.t('remote.store.smbOnly', { type: conn.type.toUpperCase() }),
          });
          return false;
        }
        
        set({ connecting: true });
        updateConnection(id, { status: 'connecting', error: undefined });
        
        try {
          // 构建 SMB URL，优先打开系统挂载对话框
          let smbUrl = `smb://${conn.host}`;
          if (conn.share) {
            smbUrl += `/${conn.share}`;
          }

          try {
            await openUrl(smbUrl);
          } catch (err) {
            console.warn('打开 SMB URL 失败，继续检测已有挂载点:', err);
          }

          const candidates = new Set(buildMountCandidates(conn));
          try {
            const volumes = await invoke<string[]>('list_volumes');
            volumes.forEach((v) => candidates.add(v));
          } catch {
            // Windows 等无 /Volumes 时忽略
          }

          let mountPoint: string | null = null;

          // 轮询挂载点是否可访问（用户可能在 Finder 中确认凭据）
          for (let attempt = 0; attempt < 12 && !mountPoint; attempt++) {
            for (const candidate of candidates) {
              try {
                const exists = await invoke<boolean>('check_path_exists', { path: candidate });
                if (!exists) continue;
                // 优先匹配 share / name
                const base = candidate.split(/[/\\]/).pop() || '';
                if (
                  (conn.share && base === conn.share) ||
                  (conn.name && base === conn.name) ||
                  candidates.size === 1
                ) {
                  mountPoint = candidate;
                  break;
                }
                // 否则先记下候选，继续找更精确的
                if (!mountPoint) mountPoint = candidate;
              } catch {
                // ignore and retry
              }
            }
            if (!mountPoint) {
              await sleep(500);
            }
          }

          if (!mountPoint) {
            updateConnection(id, {
              status: 'error',
              error: i18n.t('remote.store.mountNotDetected', {
                candidates:
                  Array.from(candidates).join(', ') || i18n.t('remote.store.mountCandidatesNone'),
              }),
            });
            set({ connecting: false });
            return false;
          }
          
          updateConnection(id, {
            status: 'connected',
            mountPoint,
            lastConnected: new Date().toISOString(),
            error: undefined,
          });
          
          set({ connecting: false, activeConnectionId: id });
          return true;
        } catch (err) {
          updateConnection(id, {
            status: 'error',
            error: mapBackendError(err),
          });
          set({ connecting: false });
          return false;
        }
      },
      
      disconnect: async (id) => {
        const { updateConnection, activeConnectionId } = get();
        
        updateConnection(id, {
          status: 'disconnected',
          mountPoint: undefined,
        });
        
        if (activeConnectionId === id) {
          set({ activeConnectionId: null });
        }
      },
    }),
    {
      name: 'filetally-remote-connections',
      partialize: (state) => ({
        // 只持久化连接配置，不保存密码和状态
        connections: state.connections.map((c) => ({
          ...c,
          password: undefined,
          status: 'disconnected' as const,
          error: undefined,
          mountPoint: undefined,
        })),
      }),
    }
  )
);
