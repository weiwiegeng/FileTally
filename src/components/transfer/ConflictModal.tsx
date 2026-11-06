import React from 'react';
import { Modal, List, Space, Typography, Tag, Radio, Button, Alert } from 'antd';
import {
  WarningOutlined,
  FileOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useTransferStore, ConflictResolution } from '../../stores';
import { useThemeColors } from '../../hooks';

const { Text } = Typography;

export const ConflictModal: React.FC = () => {
  const { t } = useTranslation();
  const {
    conflicts,
    showConflictModal,
    setShowConflictModal,
    startTransfer,
  } = useTransferStore();
  const colors = useThemeColors();

  const [resolution, setResolution] = React.useState<ConflictResolution>('rename');

  const handleConfirm = () => {
    startTransfer(resolution);
  };

  const handleCancel = () => {
    setShowConflictModal(false);
  };

  return (
    <Modal
      title={
        <Space>
          <WarningOutlined style={{ color: '#faad14' }} />
          <span>{t('transfer.conflict.title')}</span>
        </Space>
      }
      open={showConflictModal}
      onCancel={handleCancel}
      width={700}
      footer={[
        <Button key="cancel" onClick={handleCancel}>
          {t('transfer.conflict.cancel')}
        </Button>,
        <Button key="confirm" type="primary" onClick={handleConfirm}>
          {t('transfer.conflict.confirm')}
        </Button>,
      ]}
    >
      <Alert
        type="warning"
        message={t('transfer.conflict.summary', { count: conflicts.length })}
        style={{ marginBottom: 16 }}
      />

      <div style={{ marginBottom: 16 }}>
        <Text strong>{t('transfer.conflict.chooseStrategy')}</Text>
        <Radio.Group
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
          style={{ marginTop: 8, display: 'block' }}
        >
          <Space direction="vertical">
            <Radio value="rename">
              <Space>
                <span>{t('transfer.conflict.rename')}</span>
                <Text type="secondary">{t('transfer.conflict.renameHint')}</Text>
              </Space>
            </Radio>
            <Radio value="overwrite">
              <Space>
                <span>{t('transfer.conflict.overwrite')}</span>
                <Text type="secondary">{t('transfer.conflict.overwriteHint')}</Text>
              </Space>
            </Radio>
            <Radio value="skip">
              <Space>
                <span>{t('transfer.conflict.skip')}</span>
                <Text type="secondary">{t('transfer.conflict.skipHint')}</Text>
              </Space>
            </Radio>
          </Space>
        </Radio.Group>
      </div>

      <Text strong>{t('transfer.conflict.listTitle')}</Text>
      <List
        size="small"
        dataSource={conflicts}
        style={{
          maxHeight: 300,
          overflow: 'auto',
          marginTop: 8,
          border: `1px solid ${colors.border}`,
          borderRadius: 8,
        }}
        renderItem={(item) => (
          <List.Item
            style={{
              padding: '8px 12px',
              borderBottom: `1px solid ${colors.border}`,
            }}
          >
            <div style={{ width: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
                <FileOutlined style={{ marginRight: 8, color: colors.accentBlue }} />
                <Text strong ellipsis style={{ maxWidth: 400 }}>
                  {item.fileName}
                </Text>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Tag color="blue">
                  {t('transfer.conflict.tagSource', { size: item.sourceSizeFormatted })}
                </Tag>
                <SwapOutlined style={{ color: colors.textSecondary }} />
                <Tag color="orange">
                  {t('transfer.conflict.tagTarget', { size: item.targetSizeFormatted })}
                </Tag>
              </div>
            </div>
          </List.Item>
        )}
      />
    </Modal>
  );
};
