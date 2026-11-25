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

  const openAdd = () => {
    setEditingConnection(undefined);
    setShowAddModal(true);
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '16px 24px',
          borderBottom: `1px solid ${colors.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <Space align="center">
            <CloudServerOutlined style={{ fontSize: 22, color: colors.accentBlue }} />
            <Title level={4} style={{ margin: 0, color: colors.textPrimary }}>
              {t('remote.connect.title')}
            </Title>
          </Space>
          <Text
            type="secondary"
            style={{ fontSize: 13, display: 'block', marginTop: 4, marginLeft: 30 }}
          >
            {t('remote.connect.subtitle')}
          </Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>
          {t('remote.connect.addConnection')}
        </Button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        <ConnectionList onEdit={handleEdit} onAdd={openAdd} />
      </div>

      <Modal
        title={editingConnection ? t('remote.connect.modalEdit') : t('remote.connect.modalAdd')}
        open={showAddModal}
        onCancel={handleModalClose}
        footer={null}
        destroyOnClose
        width={520}
        styles={{ body: { paddingTop: 12 } }}
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
