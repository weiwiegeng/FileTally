import React from 'react';
import { Modal, List, Space, Typography, Tag, Radio, Button, Alert } from 'antd';
import {
  WarningOutlined,
  FileOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { useTransferStore, ConflictResolution } from '../../stores';
import { useThemeColors } from '../../hooks';

const { Text } = Typography;

export const ConflictModal: React.FC = () => {
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
          <span>文件冲突</span>
        </Space>
      }
      open={showConflictModal}
      onCancel={handleCancel}
      width={700}
      footer={[
        <Button key="cancel" onClick={handleCancel}>
          取消
        </Button>,
        <Button key="confirm" type="primary" onClick={handleConfirm}>
          确认处理
        </Button>,
      ]}
    >
      <Alert
        type="warning"
        message={`发现 ${conflicts.length} 个文件与目标目录中的文件重名`}
        style={{ marginBottom: 16 }}
      />

      <div style={{ marginBottom: 16 }}>
        <Text strong>请选择处理方式：</Text>
        <Radio.Group
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
          style={{ marginTop: 8, display: 'block' }}
        >
          <Space direction="vertical">
            <Radio value="rename">
              <Space>
                <span>重命名</span>
                <Text type="secondary">自动添加数字后缀，保留原文件</Text>
              </Space>
            </Radio>
            <Radio value="overwrite">
              <Space>
                <span>覆盖</span>
                <Text type="secondary">用新文件替换目标目录中的同名文件</Text>
              </Space>
            </Radio>
            <Radio value="skip">
              <Space>
                <span>跳过</span>
                <Text type="secondary">保留目标目录中的文件，不传输冲突文件</Text>
              </Space>
            </Radio>
          </Space>
        </Radio.Group>
      </div>

      <Text strong>冲突文件列表：</Text>
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
                <Tag color="blue">源: {item.sourceSizeFormatted}</Tag>
                <SwapOutlined style={{ color: colors.textSecondary }} />
                <Tag color="orange">目标: {item.targetSizeFormatted}</Tag>
              </div>
            </div>
          </List.Item>
        )}
      />
    </Modal>
  );
};
