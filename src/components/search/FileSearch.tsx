import React from 'react';
import { Typography, Space } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { SearchPanel } from './SearchPanel';
import { SearchResults } from './SearchResults';
import { useThemeColors } from '../../hooks';

const { Title } = Typography;

export const FileSearch: React.FC = () => {
  const { t } = useTranslation();
  const colors = useThemeColors();

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
          <SearchOutlined style={{ fontSize: 24, color: colors.accentBlue }} />
          <Title level={4} style={{ margin: 0, color: colors.textPrimary }}>
            {t('search.fileSearch.title')}
          </Title>
        </Space>
      </div>

      {/* Search Panel */}
      <SearchPanel />

      {/* Results */}
      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        <SearchResults />
      </div>
    </div>
  );
};
