import React from 'react';
import { Alert, Button, Card, Space, Spin, Typography, message } from 'antd';
import { CopyOutlined, RobotOutlined, SettingOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../../hooks';

const { Text, Paragraph } = Typography;

interface AiInsightCardProps {
  i18nPrefix: 'analysis.folder' | 'analysis.cleanup';
  isConfigured: boolean;
  loading: boolean;
  insight: string;
  onGenerate: () => void;
}

export const AiInsightCard: React.FC<AiInsightCardProps> = ({
  i18nPrefix,
  isConfigured,
  loading,
  insight,
  onGenerate,
}) => {
  const { t } = useTranslation();
  const colors = useThemeColors();

  const handleCopy = async () => {
    if (!insight) return;
    try {
      await navigator.clipboard.writeText(insight);
      message.success(t(`${i18nPrefix}.aiInsightCopied`));
    } catch {
      message.error(t('errors.unknown'));
    }
  };

  return (
    <Card
      title={
        <Space>
          <RobotOutlined style={{ color: colors.accentPurple }} />
          <span>{t(`${i18nPrefix}.aiInsightTitle`)}</span>
        </Space>
      }
      extra={
        <Space>
          {insight && (
            <Button size="small" icon={<CopyOutlined />} onClick={handleCopy}>
              {t('common.copy')}
            </Button>
          )}
          <Button
            type="primary"
            size="small"
            icon={<RobotOutlined />}
            loading={loading}
            disabled={!isConfigured}
            onClick={onGenerate}
          >
            {insight
              ? t(`${i18nPrefix}.aiInsightRegenerate`)
              : t(`${i18nPrefix}.aiInsightGenerate`)}
          </Button>
        </Space>
      }
      style={{ marginBottom: 24, background: colors.bgCard }}
      size="small"
    >
      {!isConfigured && (
        <Alert
          type="warning"
          showIcon
          message={t(`${i18nPrefix}.aiInsightNeedConfig`)}
          action={
            <Button size="small" icon={<SettingOutlined />}>
              {t(`${i18nPrefix}.goSettings`)}
            </Button>
          }
          style={{ marginBottom: insight || loading ? 12 : 0 }}
        />
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <Spin />
          <div style={{ marginTop: 12 }}>
            <Text type="secondary">{t(`${i18nPrefix}.aiInsightLoading`)}</Text>
          </div>
        </div>
      ) : insight ? (
        <Paragraph
          style={{
            marginBottom: 0,
            whiteSpace: 'pre-wrap',
            color: colors.textPrimary,
            lineHeight: 1.7,
          }}
        >
          {insight}
        </Paragraph>
      ) : (
        <Text type="secondary">{t(`${i18nPrefix}.aiInsightEmpty`)}</Text>
      )}
    </Card>
  );
};
