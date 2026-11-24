import React, { useEffect, useRef, useState } from 'react';
import { Button, Typography, Space, Switch, Select, Dropdown, Tag, Tooltip, Alert, Tabs } from 'antd';
import {
  FolderOpenOutlined,
  EyeOutlined,
  EyeInvisibleOutlined,
  SortAscendingOutlined,
  CloudServerOutlined,
  DownOutlined,
  ClearOutlined,
  HomeOutlined,
  StarOutlined,
  StarFilled,
  UnorderedListOutlined,
  ApartmentOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useFileStore, useSettingsStore, useRemoteStore, usePlacesStore } from '../../stores';
import { FileTree } from './FileTree';
import { FileListView } from './FileListView';
import { FilePreview } from './FilePreview';
import { useThemeColors } from '../../hooks';
import { RemoteFolderSelector } from '../search/RemoteFolderSelector';
import { isRemotePath } from '../../utils/format';
import { normalizeSortField } from '../../utils/sortFiles';

const { Title, Text } = Typography;

export const FileBrowser: React.FC = () => {
  const { t } = useTranslation();
  const { 
    currentPaths, 
    pickDirectory,
    openHomeDirectory,
    addPath,
    removePath,
    clearPaths,
    showHidden, 
    toggleShowHidden, 
    sortField, 
    sortOrder, 
    setSortField, 
    setSortOrder,
    setViewMode,
    viewMode,
    error,
  } = useFileStore();
  const { settings } = useSettingsStore();
  const { connections } = useRemoteStore();
  const { favorites, recent, addFavorite, removeFavorite, isFavorite, pushRecent } = usePlacesStore();
  const colors = useThemeColors();
  const initializedRef = useRef(false);
  const [showRemoteSelector, setShowRemoteSelector] = useState(false);
  const [activeTabPath, setActiveTabPath] = useState<string | undefined>();

  useEffect(() => {
    if (currentPaths.length && !activeTabPath) {
      setActiveTabPath(currentPaths[0]);
    }
    if (activeTabPath && !currentPaths.includes(activeTabPath)) {
      setActiveTabPath(currentPaths[0]);
    }
  }, [currentPaths, activeTabPath]);

  useEffect(() => {
    currentPaths.forEach((p) => pushRecent(p));
  }, [currentPaths.join('|')]);

  // 初次加载 + 设置变更时同步
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
    }
    if (settings.showHiddenFiles !== showHidden) {
      toggleShowHidden();
    }
    setSortField(normalizeSortField(settings.sortBy));
    setSortOrder(settings.sortOrder);
  }, [settings.showHiddenFiles, settings.sortBy, settings.sortOrder]);

  // 浏览器内改动回写设置
  const handleSortFieldChange = (value: string) => {
    const field = normalizeSortField(value);
    setSortField(field);
    useSettingsStore.getState().updateSettings({ sortBy: field });
  };
  const handleSortOrderChange = (value: 'asc' | 'desc') => {
    setSortOrder(value);
    useSettingsStore.getState().updateSettings({ sortOrder: value });
  };
  const handleShowHiddenChange = (checked: boolean) => {
    if (checked !== showHidden) toggleShowHidden();
    useSettingsStore.getState().updateSettings({ showHiddenFiles: checked });
  };

  // 获取文件夹名称
  const getFolderName = (path: string) => {
    const parts = path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || path;
  };

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
          <FolderOpenOutlined style={{ fontSize: 24, color: colors.accentOrange }} />
          <Title level={4} style={{ margin: 0, color: colors.textPrimary }}>
            {t('browser.fileBrowser.title')}
          </Title>
        </Space>
        <Space>
          <Space size="small">
            <SortAscendingOutlined style={{ color: colors.accentBlue }} />
            <Select
              size="small"
              value={sortField}
              onChange={handleSortFieldChange}
              style={{ width: 90 }}
              options={[
                { label: t('browser.fileBrowser.sortByName'), value: 'name' },
                { label: t('browser.fileBrowser.sortBySize'), value: 'size' },
                { label: t('browser.fileBrowser.sortByDate'), value: 'modified_time' },
                { label: t('browser.fileBrowser.sortByType'), value: 'extension' },
              ]}
            />
            <Select
              size="small"
              value={sortOrder}
              onChange={handleSortOrderChange}
              style={{ width: 70 }}
              options={[
                { label: t('browser.fileBrowser.sortAsc'), value: 'asc' },
                { label: t('browser.fileBrowser.sortDesc'), value: 'desc' },
              ]}
            />
          </Space>
          <Select
            size="small"
            value={viewMode === 'list' ? 'list' : 'tree'}
            style={{ width: 110 }}
            onChange={(v) => setViewMode(v === 'list' ? 'list' : 'tree')}
            options={[
              {
                value: 'tree',
                label: (
                  <Space>
                    <ApartmentOutlined />
                    {t('browser.fileBrowser.viewTree')}
                  </Space>
                ),
              },
              {
                value: 'list',
                label: (
                  <Space>
                    <UnorderedListOutlined />
                    {t('browser.fileBrowser.viewList')}
                  </Space>
                ),
              },
            ]}
          />
          <Space size="small">
            {showHidden ? (
              <EyeOutlined style={{ color: colors.accentBlue }} />
            ) : (
              <EyeInvisibleOutlined style={{ color: colors.textSecondary }} />
            )}
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('browser.fileBrowser.showHidden')}
            </Text>
            <Switch
              size="small"
              checked={showHidden}
              onChange={handleShowHiddenChange}
            />
          </Space>
          {activeTabPath && (
            <Button
              size="small"
              icon={isFavorite(activeTabPath) ? <StarFilled /> : <StarOutlined />}
              onClick={() => {
                if (isFavorite(activeTabPath)) {
                  const fav = favorites.find((f) => f.path === activeTabPath);
                  if (fav) removeFavorite(fav.id);
                } else {
                  addFavorite(activeTabPath);
                }
              }}
            >
              {t('places.addFavorite')}
            </Button>
          )}
          {currentPaths.length > 0 && (
            <Button
              size="small"
              icon={<ClearOutlined />}
              onClick={clearPaths}
              danger
            >
              {t('browser.fileBrowser.clearAll')}
            </Button>
          )}
          <Dropdown
            menu={{
              items: [
                {
                  key: 'local',
                  label: t('browser.fileBrowser.localFolder'),
                  icon: <FolderOpenOutlined />,
                  onClick: pickDirectory,
                },
                {
                  key: 'home',
                  label: t('browser.fileBrowser.homeFolder'),
                  icon: <HomeOutlined />,
                  onClick: () => { void openHomeDirectory(); },
                },
                {
                  key: 'remote',
                  label: t('browser.fileBrowser.remoteFolder'),
                  icon: <CloudServerOutlined />,
                  onClick: () => setShowRemoteSelector(true),
                  disabled: connections.length === 0,
                },
              ],
            }}
          >
            <Button type="primary">
              <Space>
                <FolderOpenOutlined />
                <span>{t('browser.fileBrowser.selectFolder')}</span>
                {currentPaths.length > 0 && (
                  <Tag color="blue" style={{ marginLeft: 4 }}>{currentPaths.length}</Tag>
                )}
                <DownOutlined style={{ fontSize: 10 }} />
              </Space>
            </Button>
          </Dropdown>
        </Space>
      </div>

      {(favorites.length > 0 || recent.length > 0) && (
        <div
          style={{
            padding: '6px 24px',
            borderBottom: `1px solid ${colors.border}`,
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          {favorites.slice(0, 8).map((f) => (
            <Tag
              key={f.id}
              color="gold"
              style={{ cursor: 'pointer' }}
              onClick={() => void addPath(f.path)}
            >
              <StarFilled /> {f.label}
            </Tag>
          ))}
          {recent.slice(0, 5).map((r) => (
            <Tag
              key={r.id}
              style={{ cursor: 'pointer' }}
              onClick={() => void addPath(r.path)}
            >
              {r.label}
            </Tag>
          ))}
        </div>
      )}

      {currentPaths.length > 0 && (
        <Tabs
          type="editable-card"
          hideAdd
          size="small"
          activeKey={activeTabPath}
          onChange={setActiveTabPath}
          onEdit={(key, action) => {
            if (action === 'remove' && typeof key === 'string') removePath(key);
          }}
          style={{ padding: '0 16px', marginBottom: 0 }}
          items={currentPaths.map((path) => ({
            key: path,
            label: (
              <Tooltip title={path}>
                <span>
                  {isRemotePath(path) ? <CloudServerOutlined style={{ marginRight: 4 }} /> : null}
                  {getFolderName(path)}
                </span>
              </Tooltip>
            ),
          }))}
        />
      )}

      {error && (
        <Alert
          type="error"
          showIcon
          closable
          message={error}
          style={{ margin: '8px 24px 0' }}
        />
      )}

      {/* Content */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: settings.previewPanelPosition === 'bottom' ? 'column' : 'row',
          overflow: 'hidden',
          minHeight: 0,
        }}
      >
        {/* File Tree Panel */}
        <div
          style={{
            width: settings.previewPanelPosition === 'bottom' ? '100%' : 400,
            height: settings.previewPanelPosition === 'bottom' ? '45%' : '100%',
            borderRight:
              settings.previewPanelPosition === 'right' ? `1px solid ${colors.border}` : undefined,
            borderBottom:
              settings.previewPanelPosition === 'bottom' ? `1px solid ${colors.border}` : undefined,
            overflow: 'auto',
            padding: 8,
          }}
        >
          {currentPaths.length > 0 ? (
            viewMode === 'list' ? <FileListView /> : <FileTree />
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                gap: 16,
              }}
            >
              <FolderOpenOutlined style={{ fontSize: 64, color: colors.border }} />
              <Text type="secondary">{t('browser.fileBrowser.emptyHint')}</Text>
            </div>
          )}
        </div>

        {/* Preview Panel */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <FilePreview />
        </div>
      </div>

      {/* 远程目录选择器 */}
      <RemoteFolderSelector
        open={showRemoteSelector}
        onClose={() => setShowRemoteSelector(false)}
        onSelect={(path) => addPath(path)}
      />
    </div>
  );
};
