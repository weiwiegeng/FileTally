import React, { useEffect, useState } from 'react';
import { Tag, Button, Space, Typography, message, Tooltip } from 'antd';
import {
  StarFilled,
  CloudServerOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  usePlacesStore,
  useRemoteStore,
  useTagStore,
  useNavigationStore,
  useDualPaneStore,
  useFileStore,
  useSettingsStore,
} from '../../stores';
import { useThemeColors } from '../../hooks';
import { formatSize } from '../../utils/format';
import type { BrowserPaneSide } from '../../stores/dualPaneStore';

const { Text } = Typography;

interface PathSpaceInfo {
  available: boolean;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

interface BrowserPlacesBarProps {
  /** When dual-pane, open into this side (default: active pane). */
  targetPane?: BrowserPaneSide;
}

export const BrowserPlacesBar: React.FC<BrowserPlacesBarProps> = ({ targetPane }) => {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { favorites, recent } = usePlacesStore();
  const { connections, connect, getAccessRoot } = useRemoteStore();
  const { getTagForPath } = useTagStore();
  const openMenu = useNavigationStore((s) => s.openMenu);
  const dualPane = useSettingsStore((s) => s.settings.dualPaneBrowser);
  const {
    activePane,
    setLeftRoot,
    setRightRoot,
    setActivePane,
  } = useDualPaneStore();
  const addPath = useFileStore((s) => s.addPath);
  const [spaceByConn, setSpaceByConn] = useState<Record<string, PathSpaceInfo>>({});

  const pane = targetPane ?? activePane;

  const openPath = async (path: string) => {
    if (dualPane) {
      if (pane === 'right') {
        setRightRoot(path);
        setActivePane('right');
      } else {
        setLeftRoot(path);
        setActivePane('left');
      }
    }
    void addPath(path);
  };

  const openConnection = async (id: string) => {
    const conn = connections.find((c) => c.id === id);
    if (!conn) return;
    if (conn.status !== 'connected') {
      message.loading({ content: t('remote.connectionList.connecting'), key: 'places-conn' });
      const ok = await connect(id);
      if (!ok) {
        message.error({
          content: t('remote.connectionList.connectFailedFallback'),
          key: 'places-conn',
        });
        return;
      }
      message.success({
        content: t('remote.connectionList.connectedSuccess'),
        key: 'places-conn',
      });
    }
    const root = getAccessRoot(
      useRemoteStore.getState().connections.find((c) => c.id === id) ?? conn
    );
    const path = root.startsWith('remote://') ? `remote://${id}/` : root;
    await openPath(path);
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const next: Record<string, PathSpaceInfo> = {};
      for (const c of connections) {
        if (c.status !== 'connected') continue;
        const root = getAccessRoot(c);
        const path = root.startsWith('remote://') ? `remote://${c.id}/` : root;
        if (!path) continue;
        try {
          const info = await invoke<PathSpaceInfo>('path_space_info', { path });
          if (info?.available) next[c.id] = info;
        } catch {
          /* ignore */
        }
      }
      if (!cancelled) setSpaceByConn(next);
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [connections, getAccessRoot]);

  const empty = favorites.length === 0 && recent.length === 0 && connections.length === 0;

  return (
    <div
      style={{
        padding: '6px 24px',
        borderBottom: `1px solid ${colors.border}`,
        display: 'flex',
        gap: 8,
        flexWrap: 'wrap',
        alignItems: 'center',
      }}
    >
      <Text type="secondary" style={{ fontSize: 11, marginRight: 4 }}>
        {t('places.barLabel')}
      </Text>
      {empty ? (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('places.emptyHint')}
        </Text>
      ) : null}
      {favorites.slice(0, 6).map((f) => {
        const tag = getTagForPath(f.path);
        return (
          <Tag
            key={`fav-${f.id}`}
            color="gold"
            style={{ cursor: 'pointer', marginInlineEnd: 0 }}
            onClick={() => void openPath(f.path)}
          >
            {tag ? (
              <span
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: tag.color,
                  marginRight: 6,
                }}
              />
            ) : (
              <StarFilled />
            )}{' '}
            {f.label}
          </Tag>
        );
      })}
      {recent.slice(0, 4).map((r) => (
        <Tag
          key={`recent-${r.id}`}
          style={{ cursor: 'pointer', marginInlineEnd: 0 }}
          onClick={() => void openPath(r.path)}
        >
          {r.label}
        </Tag>
      ))}
      {connections.slice(0, 6).map((c) => {
        const space = spaceByConn[c.id];
        const label = space
          ? `${c.name} · ${t('places.freeOfTotal', {
              free: formatSize(space.freeBytes),
              total: formatSize(space.totalBytes),
            })}`
          : c.name;
        return (
          <Tooltip
            key={`conn-${c.id}`}
            title={
              space
                ? t('places.spaceTooltip', {
                    free: formatSize(space.freeBytes),
                    used: formatSize(space.usedBytes),
                    total: formatSize(space.totalBytes),
                  })
                : undefined
            }
          >
            <Tag
              color={c.status === 'connected' ? 'blue' : 'default'}
              icon={<CloudServerOutlined />}
              style={{ cursor: 'pointer', marginInlineEnd: 0 }}
              onClick={() => void openConnection(c.id)}
            >
              {label}
            </Tag>
          </Tooltip>
        );
      })}
      <Space size={4}>
        <Button
          type="link"
          size="small"
          icon={<CloudServerOutlined />}
          onClick={() => openMenu('remote')}
          style={{ paddingInline: 4, fontSize: 12 }}
        >
          {t('places.addConnection')}
        </Button>
        <Button
          type="link"
          size="small"
          icon={<SettingOutlined />}
          onClick={() => openMenu('remote')}
          style={{ paddingInline: 4, fontSize: 12 }}
        >
          {t('places.manageConnections')}
        </Button>
      </Space>
    </div>
  );
};
