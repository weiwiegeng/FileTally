import React, { useState } from 'react';
import { Typography, Space, Button, Modal } from 'antd';
import {
  CloudServerOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { ConnectionForm } from './ConnectionForm';
import { ConnectionList } from './ConnectionList';
import { RemoteConnection } from '../../stores';
import { useThemeColors } from '../../hooks';

const { Title, Text } = Typography;

export const RemoteConnect: React.FC = () => {
  const { t } = useTranslation();
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
            {t('remote.connect.title')}
          </Title>
        </Space>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setShowAddModal(true)}
        >
          {t('remote.connect.addConnection')}
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
        <Text type="secondary" style={{ fontSize: 13, display: 'block' }}>
          {t('remote.connect.infoLine1')}
        </Text>
        <Text type="secondary" style={{ fontSize: 13, display: 'block' }}>
          {t('remote.connect.infoLine2')}
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
        title={editingConnection ? t('remote.connect.modalEdit') : t('remote.connect.modalAdd')}
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
