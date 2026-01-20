import React from 'react';
import { Tabs, Typography, Space } from 'antd';
import {
  PieChartOutlined,
  ClearOutlined,
  FileTextOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { useAnalysisStore } from '../../stores';
import { useThemeColors } from '../../hooks';
import { FolderAnalysisTab } from './FolderAnalysisTab';
import { CleanupSuggestionTab } from './CleanupSuggestionTab';
import { DocumentAssistantTab } from './DocumentAssistantTab';

const { Title, Text } = Typography;

export const AIAnalysis: React.FC = () => {
  const { activeTab, setActiveTab } = useAnalysisStore();
  const colors = useThemeColors();

  const tabItems = [
    {
      key: 'folder',
      label: (
        <Space>
          <PieChartOutlined />
          <span>文件夹分析</span>
        </Space>
      ),
      children: <FolderAnalysisTab />,
    },
    {
      key: 'cleanup',
      label: (
        <Space>
          <ClearOutlined />
          <span>清理建议</span>
        </Space>
      ),
      children: <CleanupSuggestionTab />,
    },
    {
      key: 'document',
      label: (
        <Space>
          <FileTextOutlined />
          <span>文档助手</span>
        </Space>
      ),
      children: <DocumentAssistantTab />,
    },
  ];

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
          <RobotOutlined style={{ fontSize: 24, color: colors.accentPurple }} />
          <Title level={4} style={{ margin: 0, color: colors.textPrimary }}>
            AI 分析
          </Title>
        </Space>
      </div>

      {/* Tabs Content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <Tabs
          activeKey={activeTab}
          onChange={(key) => setActiveTab(key as any)}
          items={tabItems}
          style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
          tabBarStyle={{
            padding: '0 24px',
            marginBottom: 0,
            borderBottom: `1px solid ${colors.border}`,
            flexShrink: 0,
          }}
          className="full-height-tabs"
        />
      </div>
      <style>{`
        .full-height-tabs .ant-tabs-content-holder {
          flex: 1;
          overflow: hidden;
        }
        .full-height-tabs .ant-tabs-content {
          height: 100%;
        }
        .full-height-tabs .ant-tabs-tabpane {
          height: 100%;
        }
      `}</style>
    </div>
  );
};
