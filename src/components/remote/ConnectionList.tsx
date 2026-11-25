import React from 'react';
import { List, Card, Tag, Button, Space, Popconfirm, Typography, Tooltip, message } from 'antd';
import {
  CloudServerOutlined,
  LinkOutlined,
  DisconnectOutlined,
  DeleteOutlined,
  EditOutlined,
  FolderOpenOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  GlobalOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useRemoteStore, RemoteConnection, openConnectionInFinder } from '../../stores/remoteStore';
import { useNavigationStore } from '../../stores';

const { Text } = Typography;

interface ConnectionListProps {
  onEdit?: (connection: RemoteConnection) => void;
  onBrowse?: (connection: RemoteConnection) => void;
  onAdd?: () => void;
}

const typeLabel = (type: RemoteConnection['type'] | undefined) => {
  if (type === 'webdav') return 'WebDAV';
  if (type === 'sftp') return 'SFTP';
  return 'SMB';
};

const typeColor = (type: RemoteConnection['type'] | undefined) => {
  if (type === 'webdav') return 'purple';
  if (type === 'sftp') return 'cyan';
  return 'blue';
};

const endpointText = (conn: RemoteConnection) => {
  if (conn.type === 'webdav') return conn.baseUrl || conn.host || '';
  const host = conn.host || '';
  const port = conn.port && conn.port !== (conn.type === 'sftp' ? 22 : 445) ? `:${conn.port}` : '';
  return `${host}${port}`;
};

const pathText = (conn: RemoteConnection) => {
  if (conn.type === 'webdav') return null;
  if (conn.type === 'sftp') return conn.remoteRoot || '/';
  return conn.share ? `/${conn.share}` : null;
};

const getStatusIcon = (status: RemoteConnection['status']) => {
  switch (status) {
    case 'connected':
      return <CheckCircleOutlined style={{ color: '#52c41a' }} />;
    case 'connecting':
      return <LoadingOutlined style={{ color: '#1890ff' }} />;
    case 'error':
      return <CloseCircleOutlined style={{ color: '#ff4d4f' }} />;
    default:
      return <DisconnectOutlined style={{ color: '#8c8c8c' }} />;
  }
};

export const ConnectionList: React.FC<ConnectionListProps> = ({
  onEdit,
  onBrowse,
  onAdd,
}) => {
  const { t } = useTranslation();
  const { connections, removeConnection, connect, disconnect, connecting, getAccessRoot } =
    useRemoteStore();
  const openBrowserAt = useNavigationStore((s) => s.openBrowserAt);

  const getStatusTag = (conn: RemoteConnection) => {
    switch (conn.status) {
      case 'connected':
        return (
          <Tag color="success">
            {(conn.mode || 'direct') === 'direct'
              ? t('remote.connectionList.statusDirectConnected')
              : t('remote.connectionList.statusConnected')}
          </Tag>
        );
      case 'connecting':
        return <Tag color="processing">{t('remote.connectionList.statusConnecting')}</Tag>;
      case 'error':
        return <Tag color="error">{t('remote.connectionList.statusFailed')}</Tag>;
      default:
        return <Tag>{t('remote.connectionList.statusDisconnected')}</Tag>;
    }
  };

  const handleConnect = async (conn: RemoteConnection) => {
    if (conn.status === 'connected') {
      await disconnect(conn.id);
      message.info(t('remote.connectionList.disconnected'));
    } else {
      message.loading({ content: t('remote.connectionList.connecting'), key: 'remote-connect' });
      const ok = await connect(conn.id);
      if (ok) {
        message.success({ content: t('remote.connectionList.connectedSuccess'), key: 'remote-connect' });
      } else {
        const latest = useRemoteStore.getState().connections.find((c) => c.id === conn.id);
        message.error({
          content: latest?.error || t('remote.connectionList.connectFailedFallback'),
          key: 'remote-connect',
        });
      }
    }
  };

  const handleOpenInBrowser = async (conn: RemoteConnection) => {
    if (conn.status !== 'connected') {
      message.loading({ content: t('remote.connectionList.connecting'), key: 'open-browser' });
      const ok = await connect(conn.id);
      if (!ok) {
        message.error({ content: t('remote.connectionList.connectFailedFallback'), key: 'open-browser' });
        return;
      }
      message.success({ content: t('remote.connectionList.connectedSuccess'), key: 'open-browser' });
    }
    const path = `remote://${conn.id}/`;
    openBrowserAt(path, 'left');
    message.success(t('remote.connectionList.openInBrowserSuccess'));
  };

  const handleBrowse = async (conn: RemoteConnection) => {
    const root = getAccessRoot(conn);
    if (root.startsWith('remote://')) {
      message.info(t('remote.connectionList.directBrowseHint'));
      onBrowse?.(conn);
      return;
    }
    try {
      await openConnectionInFinder(conn);
    } catch {
      message.error(t('remote.connectionList.openFailed'));
    }
    onBrowse?.(conn);
  };

  if (connections.length === 0) {
    return (
      <div
        style={{
          textAlign: 'center',
          padding: '56px 24px',
          color: '#8c8c8c',
        }}
      >
        <CloudServerOutlined style={{ fontSize: 48, marginBottom: 16 }} />
        <div style={{ marginBottom: 8, fontSize: 15 }}>{t('remote.connectionList.emptyTitle')}</div>
        <Text type="secondary" style={{ display: 'block', marginBottom: 20 }}>
          {t('remote.connectionList.emptyHint')}
        </Text>
        {onAdd ? (
          <Button type="primary" icon={<LinkOutlined />} onClick={onAdd}>
            {t('remote.connect.addConnection')}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <List
      grid={{ gutter: 16, xs: 1, sm: 1, md: 2, lg: 2, xl: 3, xxl: 4 }}
      dataSource={connections}
      renderItem={(conn) => (
        <List.Item>
          <Card
            size="small"
            title={
              <Space>
                {getStatusIcon(conn.status)}
                <Text strong ellipsis style={{ maxWidth: 150 }}>
                  {conn.name}
                </Text>
              </Space>
            }
            extra={getStatusTag(conn)}
            actions={[
              <Tooltip
                title={
                  conn.status === 'connected'
                    ? t('remote.connectionList.tooltipDisconnect')
                    : t('remote.connectionList.tooltipConnect')
                }
                key="connect"
              >
                <Button
                  type="text"
                  size="small"
                  icon={conn.status === 'connected' ? <DisconnectOutlined /> : <LinkOutlined />}
                  onClick={() => handleConnect(conn)}
                  loading={connecting && (conn.status === 'connecting' || connecting)}
                  disabled={connecting && conn.status !== 'connecting' && conn.status !== 'connected'}
                />
              </Tooltip>,
              <Tooltip title={t('remote.connectionList.tooltipOpenFinder')} key="browse">
                <Button
                  type="text"
                  size="small"
                  icon={<FolderOpenOutlined />}
                  onClick={() => handleBrowse(conn)}
                  disabled={conn.status !== 'connected' && (conn.mode || 'direct') === 'direct'}
                />
              </Tooltip>,
              <Tooltip title={t('remote.connectionList.openInBrowser')} key="open-browser">
                <Button
                  type="text"
                  size="small"
                  icon={<CloudServerOutlined />}
                  onClick={() => void handleOpenInBrowser(conn)}
                />
              </Tooltip>,
              <Tooltip title={t('remote.connectionList.tooltipEdit')} key="edit">
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => onEdit?.(conn)}
                />
              </Tooltip>,
              <Popconfirm
                title={t('remote.connectionList.deleteConfirm')}
                onConfirm={() => {
                  removeConnection(conn.id);
                  message.success(t('remote.connectionList.deleteSuccess'));
                }}
                key="delete"
              >
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                />
              </Popconfirm>,
            ]}
            style={{
              borderLeft: `3px solid ${
                conn.status === 'connected' ? '#52c41a' :
                conn.status === 'error' ? '#ff4d4f' : '#303050'
              }`,
            }}
          >
            <div style={{ marginBottom: 8 }}>
              <Space size="small" wrap>
                <Tag color={typeColor(conn.type)}>{typeLabel(conn.type)}</Tag>
                {conn.type === 'smb' ? (
                  <Tag>
                    {(conn.mode || 'direct') === 'direct'
                      ? t('remote.connectionList.modeDirect')
                      : t('remote.connectionList.modeSystem')}
                  </Tag>
                ) : null}
              </Space>
            </div>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                <GlobalOutlined /> {endpointText(conn)}
              </Text>
            </div>
            {pathText(conn) ? (
              <div style={{ marginTop: 4 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  <FolderOpenOutlined /> {pathText(conn)}
                </Text>
              </div>
            ) : null}
            {conn.mountPoint && (
              <div style={{ marginTop: 4 }}>
                <Text type="secondary" style={{ fontSize: 11 }} ellipsis>
                  {conn.mountPoint}
                </Text>
              </div>
            )}
            {conn.lastConnected && (
              <div style={{ marginTop: 8 }}>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {t('remote.connectionList.lastConnected', {
                    datetime: new Date(conn.lastConnected).toLocaleString(),
                  })}
                </Text>
              </div>
            )}
            {conn.error && (
              <div style={{ marginTop: 8 }}>
                <Text type="danger" style={{ fontSize: 11 }}>
                  {conn.error}
                </Text>
              </div>
            )}
          </Card>
        </List.Item>
      )}
    />
  );
};
