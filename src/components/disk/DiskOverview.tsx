import React, { useEffect } from 'react';
import { Typography, Button, Space, Spin, Alert, Empty } from 'antd';
import { ReloadOutlined, DatabaseOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useDiskStore } from '../../stores';
import { DiskCard } from './DiskCard';
import { formatSize } from '../../utils';
import { useThemeColors } from '../../hooks';

const { Title, Text } = Typography;

export const DiskOverview: React.FC = () => {
  const { t } = useTranslation();
  const { diskOverview, loading, error, fetchDisks, refreshDisks } = useDiskStore();
  const colors = useThemeColors();

  useEffect(() => {
    fetchDisks();
  }, [fetchDisks]);

  if (loading && !diskOverview) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
        <Spin size="large" tip={t('disk.overview.loadingTip')} />
      </div>
    );
  }

  if (error) {
    return (
      <Alert
        message={t('disk.overview.errorMessage')}
        description={error}
        type="error"
        showIcon
        style={{ margin: 20 }}
      />
    );
  }

  if (!diskOverview || diskOverview.disks.length === 0) {
    return <Empty description={t('disk.overview.empty')} style={{ padding: 60 }} />;
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <Space>
          <DatabaseOutlined style={{ fontSize: 24, color: colors.accentBlue }} />
          <Title level={4} style={{ margin: 0, color: colors.textPrimary }}>
            {t('disk.overview.title')}
          </Title>
          <Text type="secondary">
            {t('disk.overview.diskCount', { count: diskOverview.total_count })}
          </Text>
        </Space>
        <Button
          icon={<ReloadOutlined spin={loading} />}
          onClick={refreshDisks}
          loading={loading}
        >
          {t('disk.overview.refresh')}
        </Button>
      </div>

      {/* Summary */}
      <div
        style={{
          background: colors.bgCardGradient,
          borderRadius: 12,
          padding: 20,
          marginBottom: 24,
          border: `1px solid ${colors.border}`,
        }}
      >
        <Space size="large">
          <div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              {t('disk.summary.totalCapacity')}
            </Text>
            <Text style={{ color: colors.textPrimary, fontSize: 20, fontWeight: 600 }}>
              {formatSize(diskOverview.total_space)}
            </Text>
          </div>
          <div style={{ width: 1, height: 40, background: colors.border }} />
          <div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              {t('disk.summary.used')}
            </Text>
            <Text style={{ color: colors.accentOrange, fontSize: 20, fontWeight: 600 }}>
              {formatSize(diskOverview.total_used)}
            </Text>
          </div>
          <div style={{ width: 1, height: 40, background: colors.border }} />
          <div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              {t('disk.summary.available')}
            </Text>
            <Text style={{ color: colors.accentGreen, fontSize: 20, fontWeight: 600 }}>
              {formatSize(diskOverview.total_available)}
            </Text>
          </div>
        </Space>
      </div>

      {/* Disk Cards */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        {diskOverview.disks.map((disk, index) => (
          <DiskCard key={`${disk.mount_point}-${index}`} disk={disk} />
        ))}
      </div>
    </div>
  );
};
