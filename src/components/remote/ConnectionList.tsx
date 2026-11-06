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
import { useRemoteStore, RemoteConnection } from '../../stores';
import { openUrl } from '@tauri-apps/plugin-opener';

const { Text } = Typography;

interface ConnectionListProps {
  onEdit?: (connection: RemoteConnection) => void;
  onBrowse?: (connection: RemoteConnection) => void;
}

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

const getTypeLabel = (type: RemoteConnection['type']) => {
  switch (type) {
    case 'smb':
      return 'SMB';
    case 'nfs':
      return 'NFS';
    case 'ftp':
      return 'FTP';
    default:
      return type;
  }
};

export const ConnectionList: React.FC<ConnectionListProps> = ({
  onEdit,
  onBrowse,
}) => {
  const { t } = useTranslation();
  const { connections, removeConnection, connect, disconnect, connecting } = useRemoteStore();

  const getStatusTag = (status: RemoteConnection['status']) => {
    switch (status) {
      case 'connected':
        return <Tag color="success">{t('remote.connectionList.statusConnected')}</Tag>;
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

  const handleBrowse = async (conn: RemoteConnection) => {
    const mountPoint = conn.mountPoint || `/Volumes/${conn.share}`;
    try {
      await openUrl(`file://${mountPoint}`);
    } catch {
      const smbUrl = `smb://${conn.host}/${conn.share}`;
      await openUrl(smbUrl);
    }
    onBrowse?.(conn);
  };

  if (connections.length === 0) {
    return (
      <div
        style={{
          textAlign: 'center',
          padding: 40,
          color: '#8c8c8c',
        }}
      >
        <CloudServerOutlined style={{ fontSize: 48, marginBottom: 16 }} />
        <div>{t('remote.connectionList.emptyTitle')}</div>
        <Text type="secondary">{t('remote.connectionList.emptyHint')}</Text>
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
            extra={getStatusTag(conn.status)}
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
              <Space size="small">
                <Tag color="blue">{getTypeLabel(conn.type)}</Tag>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  <GlobalOutlined /> {conn.host}
                </Text>
              </Space>
            </div>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                <FolderOpenOutlined /> /{conn.share}
              </Text>
            </div>
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
