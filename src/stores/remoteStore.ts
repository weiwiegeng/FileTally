import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { openPath } from '@tauri-apps/plugin-opener';
import i18n from '../i18n';
import { mapBackendError } from '../utils/backendError';

export type RemoteConnectionMode = 'direct' | 'system';

export interface RemoteConnection {
  id: string;
  name: string;
  type: 'smb' | 'nfs' | 'ftp';
  mode: RemoteConnectionMode;
  host: string;
  port?: number;
  share: string;
  username?: string;
  password?: string;
  /** Local mount point (system) or `remote://{id}/` (direct) */
  mountPoint?: string;
  lastConnected?: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
}

interface RemoteState {
  connections: RemoteConnection[];
  activeConnectionId: string | null;
  connecting: boolean;

  addConnection: (conn: Omit<RemoteConnection, 'id' | 'status'>) => void;
  updateConnection: (id: string, updates: Partial<RemoteConnection>) => void;
  removeConnection: (id: string) => void;
  setActiveConnection: (id: string | null) => void;
  connect: (id: string) => Promise<boolean>;
  disconnect: (id: string) => Promise<void>;
  getConnection: (id: string) => RemoteConnection | undefined;
  getAccessRoot: (conn: RemoteConnection) => string;
}

const generateId = () => Math.random().toString(36).substring(2, 15);

const buildUncPath = (host: string, share: string) => `\\\\${host}\\${share}`;

export const useRemoteStore = create<RemoteState>()(
  persist(
    (set, get) => ({
      connections: [],
      activeConnectionId: null,
      connecting: false,

      addConnection: (conn) => {
        const newConnection: RemoteConnection = {
          ...conn,
          mode: conn.mode || 'direct',
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
        const conn = get().connections.find((c) => c.id === id);
        if (conn?.mode === 'direct' && conn.status === 'connected') {
          void invoke('disconnect_smb', { connectionId: id }).catch(() => undefined);
        }
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

      getAccessRoot: (conn) => {
        if (conn.mountPoint) return conn.mountPoint;
        if (conn.mode === 'direct') return `remote://${conn.id}/`;
        // system mode fallbacks
        if (typeof navigator !== 'undefined' && /Win/i.test(navigator.platform)) {
          return buildUncPath(conn.host, conn.share);
        }
        return `/Volumes/${conn.share}`;
      },

      connect: async (id) => {
        const { updateConnection, connecting, getAccessRoot } = get();
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

        const mode: RemoteConnectionMode = conn.mode || 'direct';

        set({ connecting: true });
        updateConnection(id, { status: 'connecting', error: undefined });

        try {
          if (mode === 'direct') {
            if (!conn.username?.trim()) {
              updateConnection(id, {
                status: 'error',
                error: i18n.t('remote.store.usernameRequired'),
              });
              set({ connecting: false });
              return false;
            }

            const remoteRoot = await invoke<string>('connect_smb', {
              connectionId: id,
              host: conn.host,
              share: conn.share,
              username: conn.username,
              password: conn.password || '',
              port: conn.port || 445,
            });

            updateConnection(id, {
              status: 'connected',
              mountPoint: remoteRoot,
              lastConnected: new Date().toISOString(),
              error: undefined,
            });
            set({ connecting: false, activeConnectionId: id });
            return true;
          }

          // system mount mode
          const result = await invoke<{ mountPoint: string }>('connect_system_smb', {
            host: conn.host,
            share: conn.share,
            username: conn.username || null,
            password: conn.password || null,
            timeoutMs: 30000,
          });

          updateConnection(id, {
            status: 'connected',
            mountPoint: result.mountPoint || getAccessRoot({ ...conn, mode: 'system' }),
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
        const { updateConnection, activeConnectionId, getConnection } = get();
        const conn = getConnection(id);

        if (conn?.mode === 'direct') {
          try {
            await invoke('disconnect_smb', { connectionId: id });
          } catch {
            // ignore
          }
        }

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
        connections: state.connections.map((c) => ({
          ...c,
          password: undefined,
          status: 'disconnected' as const,
          error: undefined,
          mountPoint: undefined,
          mode: c.mode || 'direct',
        })),
      }),
      merge: (persisted, current) => {
        const p = persisted as Partial<RemoteState> | undefined;
        return {
          ...current,
          ...p,
          connections: (p?.connections || []).map((c) => ({
            ...c,
            mode: c.mode || 'direct',
            status: 'disconnected' as const,
            password: undefined,
            mountPoint: undefined,
            error: undefined,
          })),
        };
      },
    }
  )
);

/** Open mount point in system file manager (system mode only). */
export async function openConnectionInFinder(conn: RemoteConnection) {
  const root = useRemoteStore.getState().getAccessRoot(conn);
  if (root.startsWith('remote://')) {
    return;
  }
  await openPath(root);
}
