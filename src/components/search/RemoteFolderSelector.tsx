import React, { useState, useEffect } from 'react';
import {
  Modal,
  List,
  Button,
  Space,
  Typography,
  Tag,
  Empty,
  Input,
  message,
} from 'antd';
import {
  CloudServerOutlined,
  FolderOutlined,
  CheckCircleOutlined,
  LinkOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useRemoteStore, RemoteConnection } from '../../stores';
import { useThemeColors } from '../../hooks';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

const { Text, Paragraph } = Typography;

interface RemoteFolderSelectorProps {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string, connectionName?: string) => void;
}

const joinRemoteSubpath = (base: string, sub: string) => {
  const cleaned = sub.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  if (!cleaned) return base.endsWith('/') ? base : `${base}/`;
  if (base.startsWith('remote://')) {
    const root = base.endsWith('/') ? base.slice(0, -1) : base;
    return `${root}/${cleaned}`;
  }
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[/\\]+$/, '')}${sep}${cleaned.split('/').join(sep)}`;
};

export const RemoteFolderSelector: React.FC<RemoteFolderSelectorProps> = ({
  open: isOpen,
  onClose,
  onSelect,
}) => {
  const { t } = useTranslation();
  const { connections, getAccessRoot, connect } = useRemoteStore();
  const colors = useThemeColors();
  const [selectedConnection, setSelectedConnection] = useState<RemoteConnection | null>(null);
  const [subPath, setSubPath] = useState('');
  const [checking, setChecking] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setSelectedConnection(null);
      setSubPath('');
    }
  }, [isOpen]);

  const getMountPath = (conn: RemoteConnection) => getAccessRoot(conn);

  const checkPathExists = async (path: string): Promise<boolean> => {
    try {
      return await invoke<boolean>('check_path_exists', { path });
    } catch {
      return false;
    }
  };

  const ensureConnected = async (conn: RemoteConnection): Promise<RemoteConnection | null> => {
    if (conn.status === 'connected' && conn.mountPoint) {
      return conn;
    }
    setConnectingId(conn.id);
    const ok = await connect(conn.id);
    setConnectingId(null);
    if (!ok) {
      const latest = useRemoteStore.getState().connections.find((c) => c.id === conn.id);
      message.error(latest?.error || t('remote.connectionList.connectFailedFallback'));
      return null;
    }
    return useRemoteStore.getState().connections.find((c) => c.id === conn.id) || null;
  };

  const handleSelectSubFolder = async () => {
    if (!selectedConnection) return;

    const live = await ensureConnected(selectedConnection);
    if (!live) return;
    setSelectedConnection(live);

    const basePath = getMountPath(live);
    if (basePath.startsWith('remote://')) {
      message.info(t('search.remoteFolderSelector.directSubdirHint'));
      return;
    }

    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('search.remoteFolderSelector.dialogBrowseSubdir'),
        defaultPath: basePath,
      });

      if (selected) {
        onSelect(selected as string, live.name);
        onClose();
      }
    } catch (err) {
      console.error('select directory failed:', err);
    }
  };

  const handleConfirm = async () => {
    if (!selectedConnection) return;

    setChecking(true);
    const live = await ensureConnected(selectedConnection);
    if (!live) {
      setChecking(false);
      return;
    }
    setSelectedConnection(live);

    const basePath = getMountPath(live);
    const fullPath = subPath ? joinRemoteSubpath(basePath, subPath) : basePath;

    const exists = await checkPathExists(fullPath);
    setChecking(false);

    if (exists) {
      onSelect(fullPath, live.name);
      onClose();
    } else {
      message.error(t('search.remoteFolderSelector.pathNotExist'));
    }
  };

  const getStatusTag = (conn: RemoteConnection) => {
    switch (conn.status) {
      case 'connected':
        return <Tag color="success">{t('search.remoteFolderSelector.statusConnected')}</Tag>;
      case 'connecting':
        return <Tag color="processing">{t('search.remoteFolderSelector.statusConnecting')}</Tag>;
      case 'error':
        return <Tag color="error">{t('search.remoteFolderSelector.statusError')}</Tag>;
      default:
        return <Tag>{t('search.remoteFolderSelector.statusDisconnected')}</Tag>;
    }
  };

  return (
    <Modal
      title={
        <Space>
          <CloudServerOutlined style={{ color: colors.accentPurple }} />
          <span>{t('search.remoteFolderSelector.modalTitle')}</span>
        </Space>
      }
      open={isOpen}
      onCancel={onClose}
      footer={null}
      width={500}
      destroyOnClose
    >
      {connections.length === 0 ? (
        <Empty
          description={t('search.remoteFolderSelector.emptyConnections')}
          style={{ padding: '40px 0' }}
        >
          <Text type="secondary">{t('search.remoteFolderSelector.emptyHint')}</Text>
        </Empty>
      ) : !selectedConnection ? (
        <>
          <Paragraph type="secondary" style={{ marginBottom: 16 }}>
            {t('search.remoteFolderSelector.pickConnection')}
          </Paragraph>
          <List
            dataSource={connections}
            renderItem={(conn) => (
              <List.Item
                style={{
                  cursor: 'pointer',
                  padding: '12px 16px',
                  borderRadius: 8,
                  marginBottom: 8,
                  border: `1px solid ${colors.border}`,
                  background: colors.bgSecondary,
                }}
                onClick={() => setSelectedConnection(conn)}
              >
                <List.Item.Meta
                  avatar={
                    <CloudServerOutlined
                      style={{ fontSize: 24, color: colors.accentPurple }}
                    />
                  }
                  title={
                    <Space>
                      <Text strong>{conn.name}</Text>
                      {getStatusTag(conn)}
                      <Tag>
                        {(conn.mode || 'direct') === 'direct'
                          ? t('remote.connectionList.modeDirect')
                          : t('remote.connectionList.modeSystem')}
                      </Tag>
                    </Space>
                  }
                  description={
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {conn.host}/{conn.share}
                    </Text>
                  }
                />
              </List.Item>
            )}
          />
        </>
      ) : (
        <>
          <div
            style={{
              padding: 16,
              background: colors.bgSecondary,
              borderRadius: 8,
              marginBottom: 16,
            }}
          >
            <Space direction="vertical" style={{ width: '100%' }}>
              <Space>
                <CloudServerOutlined style={{ color: colors.accentPurple }} />
                <Text strong>{selectedConnection.name}</Text>
                <Button
                  type="link"
                  size="small"
                  onClick={() => setSelectedConnection(null)}
                >
                  {t('search.remoteFolderSelector.changeConnection')}
                </Button>
              </Space>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('search.remoteFolderSelector.mountPath', {
                  path: getMountPath(selectedConnection),
                })}
              </Text>
            </Space>
          </div>

          <Paragraph type="secondary" style={{ marginBottom: 8 }}>
            {t('search.remoteFolderSelector.subdirHint')}
          </Paragraph>

          <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
            <Input
              placeholder={t('search.remoteFolderSelector.subdirPlaceholder')}
              value={subPath}
              onChange={(e) => setSubPath(e.target.value)}
              prefix={<FolderOutlined />}
            />
            <Button
              icon={<SearchOutlined />}
              onClick={handleSelectSubFolder}
              disabled={getMountPath(selectedConnection).startsWith('remote://')}
            >
              {t('search.remoteFolderSelector.browse')}
            </Button>
          </Space.Compact>

          <div
            style={{
              padding: '12px 16px',
              background: colors.isDark ? 'rgba(24, 144, 255, 0.1)' : 'rgba(24, 144, 255, 0.05)',
              borderRadius: 8,
              marginBottom: 16,
            }}
          >
            <Text type="secondary" style={{ fontSize: 12 }}>
              <CheckCircleOutlined style={{ color: colors.accentGreen, marginRight: 8 }} />
              {(selectedConnection.mode || 'direct') === 'direct'
                ? t('search.remoteFolderSelector.directTip')
                : t('search.remoteFolderSelector.finderTip')}
            </Text>
          </div>

          <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
            <Button onClick={onClose}>{t('search.remoteFolderSelector.cancel')}</Button>
            <Button
              type="primary"
              icon={<LinkOutlined />}
              onClick={handleConfirm}
              loading={checking || connectingId === selectedConnection.id}
            >
              {t('search.remoteFolderSelector.confirm')}
            </Button>
          </Space>
        </>
      )}
    </Modal>
  );
};
