import React, { useState } from 'react';
import { Typography, Space, Button, Modal, Tabs } from 'antd';
import {
  CloudServerOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { ConnectionForm } from './ConnectionForm';
import { ConnectionList } from './ConnectionList';
import { RemoteConnection } from '../../stores';
import { useThemeColors } from '../../hooks';

const { Title, Text } = Typography;

export const RemoteConnect: React.FC = () => {
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingConnection, setEditingConnection] = useState<RemoteConnection | undefined>();
  const colors = useThemeColors();

  const handleEdit = (conn: RemoteConnection) => {
    setEditingConnection(conn);
    setShowAddModal(true);
  };

  const handleModalClose = () => {
    setShowAddModal(false);
    setEditingConnection(undefined);
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div
        style={{
          padding: '16px 24px',
          borderBottom: `1px solid ${colors.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Space>
          <CloudServerOutlined style={{ fontSize: 24, color: colors.accentPurple }} />
          <Title level={4} style={{ margin: 0, color: colors.textPrimary }}>
            远程连接
          </Title>
        </Space>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setShowAddModal(true)}
        >
          添加连接
        </Button>
      </div>

      {/* 说明信息 */}
      <div
        style={{
          padding: '12px 24px',
          background: colors.isDark ? 'rgba(114, 46, 209, 0.1)' : 'rgba(114, 46, 209, 0.05)',
          borderBottom: `1px solid ${colors.border}`,
        }}
      >
        <Text type="secondary" style={{ fontSize: 13 }}>
          支持连接 SMB/CIFS 网络共享（如 NAS、Windows 共享文件夹）。
          点击连接后会调用系统网络功能，请在弹出的对话框中输入用户名和密码。
        </Text>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        <ConnectionList
          onEdit={handleEdit}
        />
      </div>

      {/* 添加/编辑连接对话框 */}
      <Modal
        title={editingConnection ? '编辑连接' : '添加新连接'}
        open={showAddModal}
        onCancel={handleModalClose}
        footer={null}
        destroyOnClose
      >
        <ConnectionForm
          editingConnection={editingConnection}
          onSuccess={handleModalClose}
          onCancel={handleModalClose}
        />
      </Modal>
    </div>
  );
};
