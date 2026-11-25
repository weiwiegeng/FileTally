import React, { useState, useMemo, useEffect } from 'react';
import { Layout, Typography, ConfigProvider, theme, Badge, Drawer } from 'antd';
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
  AppstoreOutlined,
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
const { Title, Text } = Typography;

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

const ALL_MENU_KEYS: MenuKey[] = [
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

const getSystemPrefersDark = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;

interface NavItemDef {
  key: MenuKey;
  icon: React.ReactNode;
  label: string;
}

interface NavSection {
  label?: string;
  items: NavItemDef[];
}

const NavRow: React.FC<{
  icon: React.ReactNode;
  label: React.ReactNode;
  active?: boolean;
  onClick: () => void;
  colors: { text: string; textSecondary: string; activeBg: string; activeText: string; hover: string };
}> = ({ icon, label, active, onClick, colors }) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      width: '100%',
      height: 36,
      padding: '0 12px',
      margin: '1px 0',
      border: 'none',
      borderRadius: 8,
      cursor: 'pointer',
      background: active ? colors.activeBg : 'transparent',
      color: active ? colors.activeText : colors.text,
      fontSize: 13,
      fontWeight: active ? 500 : 400,
      textAlign: 'left',
      lineHeight: 1,
      transition: 'background 0.12s ease, color 0.12s ease',
    }}
    onMouseEnter={(e) => {
      if (!active) e.currentTarget.style.background = colors.hover;
    }}
    onMouseLeave={(e) => {
      if (!active) e.currentTarget.style.background = 'transparent';
    }}
  >
    <span
      style={{
        width: 18,
        display: 'inline-flex',
        justifyContent: 'center',
        fontSize: 15,
        color: active ? colors.activeText : colors.textSecondary,
        flexShrink: 0,
      }}
    >
      {icon}
    </span>
    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      {label}
    </span>
  </button>
);

export const MainLayout: React.FC = () => {
  const { settings } = useSettingsStore();
  const { t, i18n } = useTranslation();
  const [systemDark, setSystemDark] = useState(getSystemPrefersDark);
  const [tasksDrawerOpen, setTasksDrawerOpen] = useState(false);

  const activeTaskCount = useTaskStore((s) =>
    s.tasks.filter((task) => task.status === 'running' || task.status === 'queued').length
  );
  const requestedMenu = useNavigationStore((s) => s.requestedMenu);
  const pendingBrowser = useNavigationStore((s) => s.pendingBrowser);
  const pendingTransfer = useNavigationStore((s) => s.pendingTransfer);
  const consumePending = useNavigationStore((s) => s.consumePending);

  const resolveDefaultPage = (page: string): MenuKey => {
    if (page === 'search') return 'filter';
    return (ALL_MENU_KEYS as string[]).includes(page) ? (page as MenuKey) : 'browser';
  };

  const [activeMenu, setActiveMenu] = useState<MenuKey>(() =>
    resolveDefaultPage(settings.defaultPage)
  );

  useEffect(() => {
    if (!requestedMenu) return;

    if (requestedMenu === 'tasks') {
      setTasksDrawerOpen(true);
      consumePending();
      return;
    }

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
        const setup = target ? resolveTransferSetup(sources, target) : null;
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

  useEffect(() => {
    if (i18n.language !== settings.language) {
      i18n.changeLanguage(settings.language);
    }
  }, [settings.language, i18n]);

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

  const navSections: NavSection[] = [
    {
      label: t('menu.groupWorkspace'),
      items: [
        { key: 'browser', icon: <FolderOutlined />, label: t('menu.fileBrowser') },
        { key: 'filter', icon: <SearchOutlined />, label: t('menu.smartSearch') },
      ],
    },
    {
      label: t('menu.groupWorkflow'),
      items: [
        { key: 'transfer', icon: <UploadOutlined />, label: t('menu.fileTransfer') },
        { key: 'sync', icon: <SwapOutlined />, label: t('menu.sync') },
        { key: 'trash', icon: <DeleteOutlined />, label: t('menu.trash') },
      ],
    },
    {
      label: t('menu.groupTools'),
      items: [
        { key: 'rules', icon: <FilterOutlined />, label: t('menu.rules') },
        { key: 'organize', icon: <AppstoreOutlined />, label: t('menu.organize') },
      ],
    },
    {
      label: t('menu.groupMore'),
      items: [
        { key: 'disk', icon: <DatabaseOutlined />, label: t('menu.diskMonitor') },
        { key: 'remote', icon: <CloudServerOutlined />, label: t('menu.remoteConnect') },
        { key: 'excel', icon: <FileExcelOutlined />, label: t('menu.excelCheck') },
        { key: 'ai', icon: <RobotOutlined />, label: t('menu.aiAnalysis') },
      ],
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

  const bgColors = useMemo(() => {
    if (!isDark) {
      return {
        primary: '#ffffff',
        secondary: '#f5f5f5',
        sider: '#f7f8fa',
        border: '#e8e8e8',
        text: '#1f1f1f',
        textSecondary: '#8c8c8c',
        activeBg: 'rgba(24, 144, 255, 0.12)',
        activeText: '#1677ff',
        hover: 'rgba(0, 0, 0, 0.04)',
      };
    }
    return {
      primary: '#0f0f1a',
      secondary: '#1a1a2e',
      sider: '#141422',
      border: '#2a2a40',
      text: '#f0f0f0',
      textSecondary: '#8c8c8c',
      activeBg: 'rgba(22, 119, 255, 0.22)',
      activeText: '#69b1ff',
      hover: 'rgba(255, 255, 255, 0.06)',
    };
  }, [isDark]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  const navColors = {
    text: bgColors.text,
    textSecondary: bgColors.textSecondary,
    activeBg: bgColors.activeBg,
    activeText: bgColors.activeText,
    hover: bgColors.hover,
  };

  return (
    <ConfigProvider
      locale={antdLocale}
      theme={{
        algorithm: themeAlgorithm,
        token: {
          colorPrimary: '#1677ff',
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
        <Sider
          width={212}
          style={{
            background: bgColors.sider,
            borderRight: `1px solid ${bgColors.border}`,
            height: '100vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              padding: '16px 14px 14px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: '#1677ff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <FolderOutlined style={{ color: '#fff', fontSize: 16 }} />
            </div>
            <div style={{ minWidth: 0 }}>
              <Title
                level={5}
                style={{
                  margin: 0,
                  color: bgColors.text,
                  fontSize: 15,
                  lineHeight: '20px',
                  fontWeight: 600,
                }}
              >
                {t('app.name')}
              </Title>
              <Text
                style={{
                  fontSize: 11,
                  color: bgColors.textSecondary,
                  lineHeight: '14px',
                  display: 'block',
                }}
              >
                {t('app.tagline')}
              </Text>
            </div>
          </div>

          <div
            style={{
              flex: 1,
              overflow: 'auto',
              padding: '0 8px 8px',
            }}
          >
            {navSections.map((section, idx) => (
              <div key={section.label ?? idx} style={{ marginBottom: 10 }}>
                {section.label ? (
                  <div
                    style={{
                      padding: '8px 12px 4px',
                      fontSize: 11,
                      fontWeight: 500,
                      letterSpacing: '0.02em',
                      color: bgColors.textSecondary,
                      userSelect: 'none',
                    }}
                  >
                    {section.label}
                  </div>
                ) : null}
                {section.items.map((item) => (
                  <NavRow
                    key={item.key}
                    icon={item.icon}
                    label={item.label}
                    active={activeMenu === item.key}
                    onClick={() => setActiveMenu(item.key)}
                    colors={navColors}
                  />
                ))}
              </div>
            ))}
          </div>

          <div
            style={{
              flexShrink: 0,
              borderTop: `1px solid ${bgColors.border}`,
              padding: '8px',
            }}
          >
            <NavRow
              icon={
                <Badge count={activeTaskCount} size="small" offset={[2, -1]}>
                  <UnorderedListOutlined />
                </Badge>
              }
              label={
                <>
                  {t('menu.tasks')}
                  {activeTaskCount > 0 ? (
                    <Text style={{ marginLeft: 6, fontSize: 12, color: bgColors.textSecondary }}>
                      {activeTaskCount}
                    </Text>
                  ) : null}
                </>
              }
              active={tasksDrawerOpen}
              onClick={() => setTasksDrawerOpen(true)}
              colors={navColors}
            />
            <NavRow
              icon={<SettingOutlined />}
              label={t('menu.settings')}
              active={activeMenu === 'settings'}
              onClick={() => setActiveMenu('settings')}
              colors={navColors}
            />
          </div>
        </Sider>

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

        <Drawer
          title={t('menu.tasks')}
          placement="right"
          width={720}
          open={tasksDrawerOpen}
          onClose={() => setTasksDrawerOpen(false)}
          destroyOnClose={false}
          styles={{ body: { padding: 0, height: '100%' } }}
        >
          <div style={{ height: '100%', overflow: 'auto' }}>
            <TaskCenter />
          </div>
        </Drawer>
      </Layout>
    </ConfigProvider>
  );
};
