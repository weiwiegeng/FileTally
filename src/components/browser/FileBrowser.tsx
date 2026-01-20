import React, { useEffect, useRef, useState } from 'react';
import { Button, Typography, Space, Switch, Breadcrumb, Select, Dropdown } from 'antd';
import {
  FolderOpenOutlined,
  EyeOutlined,
  EyeInvisibleOutlined,
  HomeOutlined,
  SortAscendingOutlined,
  CloudServerOutlined,
  DownOutlined,
} from '@ant-design/icons';
import { useFileStore, useSettingsStore, useRemoteStore } from '../../stores';
import { FileTree } from './FileTree';
import { FilePreview } from './FilePreview';
import { useThemeColors } from '../../hooks';
import { RemoteFolderSelector } from '../search/RemoteFolderSelector';
import { splitPath, isRemotePath } from '../../utils/format';

const { Title, Text } = Typography;

export const FileBrowser: React.FC = () => {
  const { currentPath, pickDirectory, setCurrentPath, showHidden, toggleShowHidden, sortField, sortOrder, setSortField, setSortOrder } = useFileStore();
  const { settings } = useSettingsStore();
  const { connections } = useRemoteStore();
  const colors = useThemeColors();
  const initializedRef = useRef(false);
  const [showRemoteSelector, setShowRemoteSelector] = useState(false);

  // 初次加载时应用设置中的默认值
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      // 应用默认设置
      if (settings.showHiddenFiles !== showHidden) {
        toggleShowHidden();
      }
      setSortField(settings.sortBy as any);
      setSortOrder(settings.sortOrder);
    }
  }, []);

  // Parse path for breadcrumb (cross-platform)
  const pathParts = splitPath(currentPath || '');

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
            文件浏览器
          </Title>
        </Space>
        <Space>
          <Space size="small">
            <SortAscendingOutlined style={{ color: colors.accentBlue }} />
            <Select
              size="small"
              value={sortField}
              onChange={(value) => setSortField(value as any)}
              style={{ width: 90 }}
              options={[
                { label: '名称', value: 'name' },
                { label: '大小', value: 'size' },
                { label: '日期', value: 'date' },
                { label: '类型', value: 'type' },
              ]}
            />
            <Select
              size="small"
              value={sortOrder}
              onChange={(value) => setSortOrder(value as any)}
              style={{ width: 70 }}
              options={[
                { label: '升序', value: 'asc' },
                { label: '降序', value: 'desc' },
              ]}
            />
          </Space>
          <Space size="small">
            {showHidden ? (
              <EyeOutlined style={{ color: colors.accentBlue }} />
            ) : (
              <EyeInvisibleOutlined style={{ color: colors.textSecondary }} />
            )}
            <Text type="secondary" style={{ fontSize: 12 }}>
              隐藏文件
            </Text>
            <Switch
              size="small"
              checked={showHidden}
              onChange={toggleShowHidden}
            />
          </Space>
          <Dropdown
            menu={{
              items: [
                {
                  key: 'local',
                  label: '本地文件夹',
                  icon: <FolderOpenOutlined />,
                  onClick: pickDirectory,
                },
                {
                  key: 'remote',
                  label: '远程文件夹',
                  icon: <CloudServerOutlined />,
                  onClick: () => setShowRemoteSelector(true),
                  disabled: connections.length === 0,
                },
              ],
            }}
          >
            <Button type="primary">
              <Space>
                {currentPath ? (
                  isRemotePath(currentPath) ? (
                    <CloudServerOutlined />
                  ) : (
                    <FolderOpenOutlined />
                  )
                ) : (
                  <FolderOpenOutlined />
                )}
                <span>选择文件夹</span>
                <DownOutlined style={{ fontSize: 10 }} />
              </Space>
            </Button>
          </Dropdown>
        </Space>
      </div>

      {/* Breadcrumb */}
      {currentPath && (
        <div
          style={{
            padding: '8px 24px',
            borderBottom: `1px solid ${colors.border}`,
            background: colors.bgSecondary,
          }}
        >
          <Space>
            {isRemotePath(currentPath) ? (
              <CloudServerOutlined style={{ color: colors.accentPurple }} />
            ) : (
              <HomeOutlined style={{ color: colors.textSecondary }} />
            )}
            <Breadcrumb
              items={pathParts.map((part, index) => ({
                title: (
                  <span style={{ color: index === pathParts.length - 1 ? colors.textPrimary : colors.textSecondary }}>
                    {part}
                  </span>
                ),
              }))}
            />
          </Space>
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        {/* File Tree Panel */}
        <div
          style={{
            width: 400,
            borderRight: `1px solid ${colors.border}`,
            overflow: 'auto',
            padding: 8,
            height: '100%',
          }}
        >
          {currentPath ? (
            <FileTree />
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
              <Text type="secondary">点击"选择文件夹"开始浏览</Text>
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
        onSelect={(path) => setCurrentPath(path)}
      />
    </div>
  );
};
