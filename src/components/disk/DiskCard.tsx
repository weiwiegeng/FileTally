import React from 'react';
import { Progress, Card, Typography, Space, Tag } from 'antd';
import { HddOutlined, UsbOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { DiskInfo } from '../../types';
import { formatSize } from '../../utils';
import { useThemeColors } from '../../hooks';

const { Text } = Typography;

interface DiskCardProps {
  disk: DiskInfo;
}

export const DiskCard: React.FC<DiskCardProps> = ({ disk }) => {
  const { t } = useTranslation();
  const colors = useThemeColors();
  
  const getProgressColor = (percent: number) => {
    if (percent >= 90) return colors.accentRed;
    if (percent >= 70) return colors.accentOrange;
    return colors.accentGreen;
  };

  const getDiskIcon = () => {
    if (disk.is_removable) {
      return <UsbOutlined style={{ fontSize: 24, color: colors.accentBlue }} />;
    }
    return <HddOutlined style={{ fontSize: 24, color: colors.accentPurple }} />;
  };

  return (
    <Card
      hoverable
      style={{
        width: 280,
        background: colors.bgCardGradient,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
      }}
      bodyStyle={{ padding: 20 }}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {getDiskIcon()}
          <div style={{ flex: 1 }}>
            <Text strong style={{ color: colors.textPrimary, fontSize: 16, display: 'block' }}>
              {disk.name || disk.mount_point}
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {disk.mount_point}
            </Text>
          </div>
          <Tag color={disk.disk_type === 'SSD' ? 'blue' : 'default'}>
            {disk.disk_type}
          </Tag>
        </div>

        <Progress
          percent={Math.round(disk.usage_percent)}
          strokeColor={getProgressColor(disk.usage_percent)}
          trailColor={colors.border}
          format={(percent) => (
            <span style={{ color: colors.textPrimary }}>{percent}%</span>
          )}
        />

        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              {t('disk.card.used')}
            </Text>
            <Text style={{ color: colors.textPrimary, fontWeight: 500 }}>
              {formatSize(disk.used_space)}
            </Text>
          </div>
          <div style={{ textAlign: 'center' }}>
            <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              {t('disk.card.available')}
            </Text>
            <Text style={{ color: colors.accentGreen, fontWeight: 500 }}>
              {formatSize(disk.available_space)}
            </Text>
          </div>
          <div style={{ textAlign: 'right' }}>
            <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              {t('disk.card.total')}
            </Text>
            <Text style={{ color: colors.textPrimary, fontWeight: 500 }}>
              {formatSize(disk.total_space)}
            </Text>
          </div>
        </div>

        <Text type="secondary" style={{ fontSize: 11 }}>
          {t('disk.card.fileSystem', { fileSystem: disk.file_system })}
        </Text>
      </Space>
    </Card>
  );
};
