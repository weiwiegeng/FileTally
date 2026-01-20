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

const getStatusTag = (status: RemoteConnection['status']) => {
  switch (status) {
    case 'connected':
      return <Tag color="success">已连接</Tag>;
    case 'connecting':
      return <Tag color="processing">连接中</Tag>;
    case 'error':
      return <Tag color="error">连接失败</Tag>;
    default:
      return <Tag>未连接</Tag>;
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
  const { connections, removeConnection, connect, disconnect, connecting } = useRemoteStore();

  const handleConnect = async (conn: RemoteConnection) => {
    if (conn.status === 'connected') {
      await disconnect(conn.id);
      message.info('已断开连接');
    } else {
      // 尝试在 Finder 中打开 SMB 路径
      const smbUrl = `smb://${conn.host}/${conn.share}`;
      try {
        await openUrl(smbUrl);
        message.success('正在打开远程连接，请在系统对话框中输入凭据');
        await connect(conn.id);
      } catch (err) {
        message.error('无法打开连接: ' + String(err));
      }
    }
  };

  const handleBrowse = async (conn: RemoteConnection) => {
    // 打开挂载点目录
    const mountPoint = `/Volumes/${conn.share}`;
    try {
      await openUrl(`file://${mountPoint}`);
    } catch {
      // 如果打开失败，尝试打开 SMB URL
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
        <div>暂无保存的连接</div>
        <Text type="secondary">点击"添加连接"创建新的远程连接</Text>
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
              <Tooltip title={conn.status === 'connected' ? '断开连接' : '连接'} key="connect">
                <Button
                  type="text"
                  size="small"
                  icon={conn.status === 'connected' ? <DisconnectOutlined /> : <LinkOutlined />}
                  onClick={() => handleConnect(conn)}
                  loading={connecting && conn.status === 'connecting'}
                />
              </Tooltip>,
              <Tooltip title="在 Finder 中打开" key="browse">
                <Button
                  type="text"
                  size="small"
                  icon={<FolderOpenOutlined />}
                  onClick={() => handleBrowse(conn)}
                />
              </Tooltip>,
              <Tooltip title="编辑" key="edit">
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => onEdit?.(conn)}
                />
              </Tooltip>,
              <Popconfirm
                title="确定删除此连接？"
                onConfirm={() => {
                  removeConnection(conn.id);
                  message.success('连接已删除');
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
                  上次连接: {new Date(conn.lastConnected).toLocaleString()}
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
