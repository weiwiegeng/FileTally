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
  Spin,
} from 'antd';
import {
  CloudServerOutlined,
  FolderOutlined,
  CheckCircleOutlined,
  LinkOutlined,
  SearchOutlined,
} from '@ant-design/icons';
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

export const RemoteFolderSelector: React.FC<RemoteFolderSelectorProps> = ({
  open: isOpen,
  onClose,
  onSelect,
}) => {
  const { connections } = useRemoteStore();
  const colors = useThemeColors();
  const [selectedConnection, setSelectedConnection] = useState<RemoteConnection | null>(null);
  const [subPath, setSubPath] = useState('');
  const [checking, setChecking] = useState(false);

  // 重置状态
  useEffect(() => {
    if (!isOpen) {
      setSelectedConnection(null);
      setSubPath('');
    }
  }, [isOpen]);

  // 获取挂载路径
  const getMountPath = (conn: RemoteConnection) => {
    // macOS SMB 挂载通常在 /Volumes/共享名
    return `/Volumes/${conn.share}`;
  };

  // 检查路径是否存在
  const checkPathExists = async (path: string): Promise<boolean> => {
    try {
      const exists = await invoke<boolean>('check_path_exists', { path });
      return exists;
    } catch {
      return false;
    }
  };

  // 选择子目录
  const handleSelectSubFolder = async () => {
    if (!selectedConnection) return;
    
    const basePath = getMountPath(selectedConnection);
    
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择远程目录',
        defaultPath: basePath,
      });
      
      if (selected) {
        onSelect(selected as string, selectedConnection?.name);
        onClose();
      }
    } catch (err) {
      console.error('选择目录失败:', err);
    }
  };

  // 确认选择
  const handleConfirm = async () => {
    if (!selectedConnection) return;
    
    setChecking(true);
    const basePath = getMountPath(selectedConnection);
    const fullPath = subPath ? `${basePath}/${subPath}` : basePath;
    
    const exists = await checkPathExists(fullPath);
    setChecking(false);
    
    if (exists) {
      onSelect(fullPath, selectedConnection?.name);
      onClose();
    } else {
      message.error('路径不存在，请确认 NAS 已连接并挂载');
    }
  };

  // 连接状态标签
  const getStatusTag = (conn: RemoteConnection) => {
    switch (conn.status) {
      case 'connected':
        return <Tag color="success">已连接</Tag>;
      case 'connecting':
        return <Tag color="processing">连接中</Tag>;
      case 'error':
        return <Tag color="error">错误</Tag>;
      default:
        return <Tag>未连接</Tag>;
    }
  };

  return (
    <Modal
      title={
        <Space>
          <CloudServerOutlined style={{ color: colors.accentPurple }} />
          <span>选择远程目录</span>
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
          description="暂无保存的远程连接"
          style={{ padding: '40px 0' }}
        >
          <Text type="secondary">
            请先在"远程连接"页面添加 NAS 连接
          </Text>
        </Empty>
      ) : !selectedConnection ? (
        <>
          <Paragraph type="secondary" style={{ marginBottom: 16 }}>
            选择一个已保存的远程连接：
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
                  更换
                </Button>
              </Space>
              <Text type="secondary" style={{ fontSize: 12 }}>
                挂载路径: {getMountPath(selectedConnection)}
              </Text>
            </Space>
          </div>

          <Paragraph type="secondary" style={{ marginBottom: 8 }}>
            输入子目录路径（可选）或直接浏览选择：
          </Paragraph>
          
          <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
            <Input
              placeholder="例如: Documents/项目文件"
              value={subPath}
              onChange={(e) => setSubPath(e.target.value)}
              prefix={<FolderOutlined />}
            />
            <Button
              icon={<SearchOutlined />}
              onClick={handleSelectSubFolder}
            >
              浏览
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
              提示：请确保 NAS 已通过 Finder 连接并挂载，挂载后的路径通常在 /Volumes/ 下
            </Text>
          </div>

          <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
            <Button onClick={onClose}>取消</Button>
            <Button
              type="primary"
              icon={<LinkOutlined />}
              onClick={handleConfirm}
              loading={checking}
            >
              确认选择
            </Button>
          </Space>
        </>
      )}
    </Modal>
  );
};
