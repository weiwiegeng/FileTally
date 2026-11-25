import React, { useState, useMemo, useEffect } from 'react';
import { Layout, Menu, Typography, ConfigProvider, theme } from 'antd';
import zhCNAntd from 'antd/locale/zh_CN';
import enUSAntd from 'antd/locale/en_US';
import {
  DatabaseOutlined,
  FolderOutlined,
  CloudServerOutlined,
  SearchOutlined,
  RobotOutlined,
  SettingOutlined,
  UploadOutlined,
  FileExcelOutlined,
  UnorderedListOutlined,
  FilterOutlined,
  RetweetOutlined,
  SwapOutlined,
  DeleteOutlined,
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
import { TaskCenter, TaskBridge } from '../tasks';
import { RuleFilter } from '../rules';
import { OrganizePanel } from '../organize';
import { SyncPanel } from '../sync';
import { TrashPanel } from '../trash';
import {
  useSettingsStore,
  useTaskStore,
  useNavigationStore,
  useDualPaneStore,
  useFileStore,
  useTransferStore,
} from '../../stores';
import { buildTransferItems, resolveTransferSetup } from '../browser/dualPaneTransfer';

const { Sider, Content } = Layout;
const { Title } = Typography;

type MenuKey =
  | 'disk'
  | 'browser'
  | 'remote'
  | 'filter'
  | 'transfer'
  | 'excel'
  | 'ai'
  | 'tasks'
  | 'rules'
  | 'organize'
  | 'sync'
  | 'trash'
  | 'settings';

const getSystemPrefersDark = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;

export const MainLayout: React.FC = () => {
  const { settings } = useSettingsStore();
  const { t, i18n } = useTranslation();
  const [systemDark, setSystemDark] = useState(getSystemPrefersDark);

  const activeTaskCount = useTaskStore((s) =>
    s.tasks.filter((t) => t.status === 'running' || t.status === 'queued').length
  );
  const requestedMenu = useNavigationStore((s) => s.requestedMenu);
  const pendingBrowser = useNavigationStore((s) => s.pendingBrowser);
  const pendingTransfer = useNavigationStore((s) => s.pendingTransfer);
  const consumePending = useNavigationStore((s) => s.consumePending);

  useEffect(() => {
    if (!requestedMenu) return;
    setActiveMenu(requestedMenu as MenuKey);

    if (requestedMenu === 'browser') {
      const path = pendingBrowser?.path;
      const pane = pendingBrowser?.pane;
      if (!path) {
        consumePending();
        return;
      }
      if (settings.dualPaneBrowser) {
        const dual = useDualPaneStore.getState();
        if (pane === 'right') {
          dual.setRightRoot(path);
        } else {
          dual.setLeftRoot(path);
        }
        dual.setActivePane(pane ?? 'left');
      }
      void useFileStore.getState().addPath(path);
    }

    if (requestedMenu === 'transfer' && pendingTransfer) {
      const transfer = useTransferStore.getState();
      const { sources, target } = pendingTransfer;
      void (async () => {
        const items = await buildTransferItems(sources);
        const setup = target
          ? resolveTransferSetup(sources, target)
          : null;
        transfer.setDirection(setup?.direction ?? transfer.direction);
        transfer.clearSourceItems();
        transfer.addSourceItems(items, setup?.sourceConnectionName);
        if (target) {
          transfer.setTargetPath(target, setup?.targetConnectionName);
        }
      })();
    }

    consumePending();
  }, [requestedMenu, pendingBrowser, pendingTransfer, settings.dualPaneBrowser, consumePending]);

  const resolveDefaultPage = (page: string): MenuKey => {
    if (page === 'search') return 'filter';
    const allowed: MenuKey[] = [
      'disk',
      'browser',
      'remote',
      'filter',
      'transfer',
      'excel',
      'ai',
      'tasks',
      'rules',
      'organize',
      'sync',
      'trash',
      'settings',
    ];
    return (allowed as string[]).includes(page) ? (page as MenuKey) : 'disk';
  };

  // defaultPage 只影响启动时的初始页，改设置时不强制跳转当前页
  const [activeMenu, setActiveMenu] = useState<MenuKey>(() =>
    resolveDefaultPage(settings.defaultPage)
  );

  // 监听语言设置变化，实时切换
  useEffect(() => {
    if (i18n.language !== settings.language) {
      i18n.changeLanguage(settings.language);
    }
  }, [settings.language, i18n]);

  // system 主题跟随 OS
  useEffect(() => {
    if (settings.theme !== 'system' || typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [settings.theme]);

  const isDark =
    settings.theme === 'dark' || (settings.theme === 'system' && systemDark);

  const themeAlgorithm = useMemo(
    () => (isDark ? theme.darkAlgorithm : theme.defaultAlgorithm),
    [isDark]
  );

  const antdLocale = settings.language === 'zh-CN' ? zhCNAntd : enUSAntd;

  const menuItems = [
    {
      type: 'group' as const,
      label: t('menu.groupDaily'),
      children: [
        { key: 'disk', icon: <DatabaseOutlined />, label: t('menu.diskMonitor') },
        { key: 'browser', icon: <FolderOutlined />, label: t('menu.fileBrowser') },
        { key: 'remote', icon: <CloudServerOutlined />, label: t('menu.remoteConnect') },
      ],
    },
    {
      type: 'group' as const,
      label: t('menu.groupFind'),
      children: [
        { key: 'filter', icon: <SearchOutlined />, label: t('menu.smartSearch') },
        { key: 'transfer', icon: <UploadOutlined />, label: t('menu.fileTransfer') },
      ],
    },
    {
      type: 'group' as const,
      label: t('menu.groupTools'),
      children: [
        { key: 'rules', icon: <FilterOutlined />, label: t('menu.rules') },
        { key: 'organize', icon: <RetweetOutlined />, label: t('menu.organize') },
        { key: 'sync', icon: <SwapOutlined />, label: t('menu.sync') },
        { key: 'trash', icon: <DeleteOutlined />, label: t('menu.trash') },
      ],
    },
    {
      type: 'group' as const,
      label: t('menu.groupPro'),
      children: [
        { key: 'excel', icon: <FileExcelOutlined />, label: t('menu.excelCheck') },
        { key: 'ai', icon: <RobotOutlined />, label: t('menu.aiAnalysis') },
      ],
    },
    { type: 'divider' as const },
    {
      key: 'tasks',
      icon: <UnorderedListOutlined />,
      label:
        activeTaskCount > 0
          ? `${t('menu.tasks')} (${activeTaskCount})`
          : t('menu.tasks'),
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
      case 'rules':
        return <RuleFilter />;
      case 'organize':
        return <OrganizePanel />;
      case 'sync':
        return <SyncPanel />;
      case 'trash':
        return <TrashPanel />;
      case 'tasks':
        return <TaskCenter />;
      case 'settings':
        return <Settings />;
      default:
        return null;
    }
  };

  // 根据主题设置背景色（含 system）
  const bgColors = useMemo(() => {
    if (!isDark) {
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
  }, [isDark]);

  // 同步主题到 document 属性（用于 CSS 滚动条等全局样式）
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  return (
    <ConfigProvider
      locale={antdLocale}
      theme={{
        algorithm: themeAlgorithm,
        token: {
          colorPrimary: '#1890ff',
          colorBgContainer: isDark ? '#1a1a2e' : '#ffffff',
          colorBgElevated: isDark ? '#16213e' : '#f5f5f5',
          colorBorder: bgColors.border,
          colorText: bgColors.text,
          colorTextSecondary: bgColors.textSecondary,
        },
      }}
    >
      <Layout style={{ minHeight: '100vh', background: bgColors.primary }}>
        <TaskBridge />
        {/* Sidebar */}
        <Sider
          width={220}
          style={{
            background: bgColors.sider,
            borderRight: `1px solid ${bgColors.border}`,
            height: '100vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
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
              flexShrink: 0,
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
                {t('app.name')}
              </Title>
              <div style={{ fontSize: 10, color: bgColors.textSecondary }}>
                {t('app.tagline')}
              </div>
            </div>
          </div>

          {/* Menu */}
          <div style={{ flex: 1, overflow: 'auto', paddingBottom: 12 }}>
            <Menu
              mode="inline"
              selectedKeys={[activeMenu]}
              onClick={({ key }) => setActiveMenu(key as MenuKey)}
              style={{
                background: 'transparent',
                border: 'none',
                marginTop: 4,
              }}
              items={menuItems}
            />
          </div>
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
