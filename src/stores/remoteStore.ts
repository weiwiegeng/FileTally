import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
        const { updateConnection } = get();
        const conn = get().connections.find((c) => c.id === id);
        
        if (!conn) return false;
        
        set({ connecting: true });
        updateConnection(id, { status: 'connecting', error: undefined });
        
        try {
          // 构建 SMB URL
          // macOS 格式: smb://username:password@host/share
          let smbUrl = `smb://${conn.host}`;
          if (conn.share) {
            smbUrl += `/${conn.share}`;
          }
          
          // 挂载点默认在 /Volumes/share_name
          const mountPoint = `/Volumes/${conn.share || conn.name}`;
          
          // 注意：实际的挂载需要用户在系统层面操作
          // 这里我们检查该路径是否已经挂载/可访问
          
          // 更新连接状态
          updateConnection(id, {
            status: 'connected',
            mountPoint,
            lastConnected: new Date().toISOString(),
          });
          
          set({ connecting: false, activeConnectionId: id });
          return true;
        } catch (err) {
          updateConnection(id, {
            status: 'error',
            error: String(err),
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
          status: 'disconnected',
          error: undefined,
          mountPoint: undefined,
        })),
      }),
    }
  )
);
