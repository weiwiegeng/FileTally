import React, { useState, useMemo, useEffect } from 'react';
import { Layout, Menu, Typography, ConfigProvider, theme } from 'antd';
import {
  DatabaseOutlined,
  FolderOutlined,
  CloudServerOutlined,
  SearchOutlined,
  RobotOutlined,
  SettingOutlined,
  UploadOutlined,
  FileExcelOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { DiskOverview } from '../disk';
import { FileBrowser } from '../browser';
import { FileSearch } from '../search';
import { RemoteConnect } from '../remote';
import { Settings } from '../settings';
import { AIAnalysis } from '../analysis';
import { FileTransfer } from '../transfer';
import { ExcelCheck } from '../excel';
import { useSettingsStore } from '../../stores';

const { Sider, Content, Header } = Layout;
const { Title } = Typography;

type MenuKey = 'disk' | 'browser' | 'remote' | 'filter' | 'transfer' | 'excel' | 'ai' | 'settings';

export const MainLayout: React.FC = () => {
  const { settings } = useSettingsStore();
  const { t, i18n } = useTranslation();
  const [activeMenu, setActiveMenu] = useState<MenuKey>(settings.defaultPage as MenuKey);

  // 监听语言设置变化，实时切换
  useEffect(() => {
    if (i18n.language !== settings.language) {
      i18n.changeLanguage(settings.language);
    }
  }, [settings.language, i18n]);

  // 根据设置切换主题算法
  const themeAlgorithm = useMemo(() => {
    if (settings.theme === 'light') {
      return theme.defaultAlgorithm;
    }
    return theme.darkAlgorithm;
  }, [settings.theme]);

  const menuItems = [
    {
      key: 'disk',
      icon: <DatabaseOutlined />,
      label: t('menu.diskMonitor'),
    },
    {
      key: 'browser',
      icon: <FolderOutlined />,
      label: t('menu.fileBrowser'),
    },
    {
      key: 'remote',
      icon: <CloudServerOutlined />,
      label: t('menu.remoteConnect'),
    },
    {
      key: 'filter',
      icon: <SearchOutlined />,
      label: t('menu.smartSearch'),
    },
    {
      key: 'transfer',
      icon: <UploadOutlined />,
      label: t('menu.fileTransfer'),
    },
    {
      key: 'excel',
      icon: <FileExcelOutlined />,
      label: t('menu.excelCheck'),
    },
    {
      key: 'ai',
      icon: <RobotOutlined />,
      label: t('menu.aiAnalysis'),
    },
    {
      type: 'divider' as const,
    },
    {
      key: 'settings',
      icon: <SettingOutlined />,
      label: t('menu.settings'),
    },
  ];

  const renderContent = () => {
    switch (activeMenu) {
      case 'disk':
        return <DiskOverview />;
      case 'browser':
        return <FileBrowser />;
      case 'remote':
        return <RemoteConnect />;
      case 'filter':
        return <FileSearch />;
      case 'transfer':
        return <FileTransfer />;
      case 'excel':
        return <ExcelCheck />;
      case 'ai':
        return <AIAnalysis />;
      case 'settings':
        return <Settings />;
      default:
        return null;
    }
  };

  // 根据主题设置背景色
  const bgColors = useMemo(() => {
    if (settings.theme === 'light') {
      return {
        primary: '#ffffff',
        secondary: '#f5f5f5',
        sider: 'linear-gradient(180deg, #f0f2f5 0%, #e6e8eb 100%)',
        border: '#d9d9d9',
        text: '#000000',
        textSecondary: '#595959',
      };
    }
    return {
      primary: '#0f0f1a',
      secondary: '#1a1a2e',
      sider: 'linear-gradient(180deg, #1a1a2e 0%, #16213e 100%)',
      border: '#303050',
      text: '#ffffff',
      textSecondary: '#8c8c8c',
    };
  }, [settings.theme]);

  // 同步主题到 document 属性（用于 CSS 滚动条等全局样式）
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme);
  }, [settings.theme]);

  return (
    <ConfigProvider
      theme={{
        algorithm: themeAlgorithm,
        token: {
          colorPrimary: '#1890ff',
          colorBgContainer: settings.theme === 'light' ? '#ffffff' : '#1a1a2e',
          colorBgElevated: settings.theme === 'light' ? '#f5f5f5' : '#16213e',
          colorBorder: bgColors.border,
          colorText: bgColors.text,
          colorTextSecondary: bgColors.textSecondary,
        },
      }}
    >
      <Layout style={{ minHeight: '100vh', background: bgColors.primary }}>
        {/* Sidebar */}
        <Sider
          width={220}
          style={{
            background: bgColors.sider,
            borderRight: `1px solid ${bgColors.border}`,
          }}
        >
          {/* Logo */}
          <div
            style={{
              padding: '20px 16px',
              borderBottom: `1px solid ${bgColors.border}`,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: 'linear-gradient(135deg, #1890ff 0%, #722ed1 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <FolderOutlined style={{ color: '#fff', fontSize: 18 }} />
            </div>
            <div>
              <Title level={5} style={{ margin: 0, color: bgColors.text }}>
                FileTally
              </Title>
              <div style={{ fontSize: 10, color: bgColors.textSecondary }}>
                Smart File Manager
              </div>
            </div>
          </div>

          {/* Menu */}
          <Menu
            mode="inline"
            selectedKeys={[activeMenu]}
            onClick={({ key }) => setActiveMenu(key as MenuKey)}
            style={{
              background: 'transparent',
              border: 'none',
              marginTop: 8,
            }}
            items={menuItems}
          />
        </Sider>

        {/* Main Content */}
        <Layout style={{ background: bgColors.primary, height: '100vh' }}>
          <Content
            style={{
              background: bgColors.primary,
              overflow: 'hidden',
              height: '100vh',
            }}
          >
            {renderContent()}
          </Content>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
};
