import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { openPath } from '@tauri-apps/plugin-opener';
import i18n from '../i18n';
import { mapBackendError } from '../utils/backendError';

export type RemoteConnectionMode = 'direct' | 'system';
export type RemoteProtocol = 'smb' | 'webdav' | 'sftp';

export interface RemoteConnection {
  id: string;
  name: string;
  type: RemoteProtocol;
  mode: RemoteConnectionMode;
  host: string;
  port?: number;
  share: string;
  /** WebDAV base URL when type=webdav */
  baseUrl?: string;
  /** SFTP root path */
  remoteRoot?: string;
  username?: string;
  password?: string;
  rememberPassword?: boolean;
  mountPoint?: string;
  lastConnected?: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
}

interface RemoteState {
  connections: RemoteConnection[];
  activeConnectionId: string | null;
  connecting: boolean;

  addConnection: (conn: Omit<RemoteConnection, 'id' | 'status'>) => string;
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

async function loadPassword(id: string): Promise<string | undefined> {
  try {
    const pw = await invoke<string | null>('load_connection_password', { connectionId: id });
    return pw || undefined;
  } catch {
    return undefined;
  }
}

async function persistPassword(id: string, password: string | undefined, remember?: boolean) {
  try {
    if (remember && password) {
      await invoke('save_connection_password', { connectionId: id, password });
    } else if (!remember) {
      await invoke('delete_connection_password', { connectionId: id }).catch(() => undefined);
    }
  } catch {
    // keychain may be unavailable in some environments
  }
}

export const useRemoteStore = create<RemoteState>()(
  persist(
    (set, get) => ({
      connections: [],
      activeConnectionId: null,
      connecting: false,

      addConnection: (conn) => {
        const id = generateId();
        const newConnection: RemoteConnection = {
          ...conn,
          mode: conn.mode || 'direct',
          type: conn.type || 'smb',
          id,
          status: 'disconnected',
        };
        set((state) => ({
          connections: [...state.connections, newConnection],
        }));
        if (conn.rememberPassword && conn.password) {
          void persistPassword(id, conn.password, true);
        }
        return id;
      },

      updateConnection: (id, updates) => {
        set((state) => ({
          connections: state.connections.map((c) =>
            c.id === id ? { ...c, ...updates } : c
          ),
        }));
        if (updates.password !== undefined || updates.rememberPassword !== undefined) {
          const c = get().connections.find((x) => x.id === id);
          if (c) {
            void persistPassword(
              id,
              updates.password ?? c.password,
              updates.rememberPassword ?? c.rememberPassword
            );
          }
        }
      },

      removeConnection: (id) => {
        const conn = get().connections.find((c) => c.id === id);
        if (conn?.status === 'connected') {
          void invoke('disconnect_remote', { connectionId: id }).catch(() =>
            invoke('disconnect_smb', { connectionId: id }).catch(() => undefined)
          );
        }
        void invoke('delete_connection_password', { connectionId: id }).catch(() => undefined);
        set((state) => ({
          connections: state.connections.filter((c) => c.id !== id),
          activeConnectionId: state.activeConnectionId === id ? null : state.activeConnectionId,
        }));
      },

      setActiveConnection: (id) => {
        set({ activeConnectionId: id });
      },

      getConnection: (id) => get().connections.find((c) => c.id === id),

      getAccessRoot: (conn) => {
        if (conn.mountPoint) return conn.mountPoint;
        if (conn.mode === 'direct' || conn.type === 'webdav' || conn.type === 'sftp') {
          return `remote://${conn.id}/`;
        }
        if (typeof navigator !== 'undefined' && /Win/i.test(navigator.platform)) {
          return buildUncPath(conn.host, conn.share);
        }
        return `/Volumes/${conn.share}`;
      },

      connect: async (id) => {
        const { updateConnection, connecting, getAccessRoot } = get();
        let conn = get().connections.find((c) => c.id === id);
        if (!conn) return false;
        if (connecting) return false;

        set({ connecting: true });
        updateConnection(id, { status: 'connecting', error: undefined });

        try {
          if (!conn.password) {
            const saved = await loadPassword(id);
            if (saved) {
              updateConnection(id, { password: saved });
              conn = { ...conn, password: saved };
            }
          }

          const proto = conn.type || 'smb';
          const mode: RemoteConnectionMode = conn.mode || 'direct';

          if (proto === 'webdav') {
            const base = conn.baseUrl || conn.host;
            const remoteRoot = await invoke<string>('connect_webdav', {
              connectionId: id,
              baseUrl: base,
              username: conn.username || '',
              password: conn.password || '',
              label: conn.name,
              timeoutMs: 30000,
            });
            await persistPassword(id, conn.password, conn.rememberPassword);
            updateConnection(id, {
              status: 'connected',
              mountPoint: remoteRoot,
              lastConnected: new Date().toISOString(),
              error: undefined,
            });
            set({ connecting: false, activeConnectionId: id });
            return true;
          }

          if (proto === 'sftp') {
            const remoteRoot = await invoke<string>('connect_sftp', {
              connectionId: id,
              host: conn.host,
              port: conn.port || 22,
              username: conn.username || '',
              password: conn.password || '',
              root: conn.remoteRoot || '/',
              label: conn.name,
            });
            await persistPassword(id, conn.password, conn.rememberPassword);
            updateConnection(id, {
              status: 'connected',
              mountPoint: remoteRoot,
              lastConnected: new Date().toISOString(),
              error: undefined,
            });
            set({ connecting: false, activeConnectionId: id });
            return true;
          }

          // SMB
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
            await persistPassword(id, conn.password, conn.rememberPassword);
            updateConnection(id, {
              status: 'connected',
              mountPoint: remoteRoot,
              lastConnected: new Date().toISOString(),
              error: undefined,
            });
            set({ connecting: false, activeConnectionId: id });
            return true;
          }

          const result = await invoke<{ mountPoint: string }>('connect_system_smb', {
            host: conn.host,
            share: conn.share,
            username: conn.username || null,
            password: conn.password || null,
            timeoutMs: 30000,
          });
          await persistPassword(id, conn.password, conn.rememberPassword);
          updateConnection(id, {
            status: 'connected',
            mountPoint: result.mountPoint || getAccessRoot({ ...conn, mode: 'system' }),
            lastConnected: new Date().toISOString(),
            error: undefined,
          });
          set({ connecting: false, activeConnectionId: id });
          return true;
        } catch (err) {
          const msg = mapBackendError(err);
          // Auto-heal: missing session after restart — already tried load password above
          updateConnection(id, { status: 'error', error: msg });
          set({ connecting: false });
          return false;
        }
      },

      disconnect: async (id) => {
        const { updateConnection, activeConnectionId, getConnection } = get();
        const conn = getConnection(id);
        if (conn) {
          try {
            await invoke('disconnect_remote', { connectionId: id });
          } catch {
            try {
              await invoke('disconnect_smb', { connectionId: id });
            } catch {
              // ignore
            }
          }
        }
        updateConnection(id, { status: 'disconnected', mountPoint: undefined });
        if (activeConnectionId === id) set({ activeConnectionId: null });
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
            type: (c.type as RemoteProtocol) || 'smb',
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

export async function openConnectionInFinder(conn: RemoteConnection) {
  const root = useRemoteStore.getState().getAccessRoot(conn);
  if (root.startsWith('remote://')) return;
  await openPath(root);
}
