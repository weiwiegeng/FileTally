import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Typography,
  Space,
  Switch,
  Select,
  Tag,
  Tooltip,
  Alert,
  message,
  Modal,
} from 'antd';
import {
  FolderOpenOutlined,
  EyeOutlined,
  EyeInvisibleOutlined,
  SortAscendingOutlined,
  CopyOutlined,
  SwapOutlined,
  DeleteOutlined,
  UnorderedListOutlined,
  ApartmentOutlined,
  EnterOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  useFileStore,
  useSettingsStore,
  useDualPaneStore,
  useTransferStore,
} from '../../stores';
import { looksLikeSystemPath } from '../../utils/pathNav';
import { BrowserPane } from './BrowserPane';
import { FilePreview } from './FilePreview';
import { ConflictModal } from '../transfer/ConflictModal';
import { useThemeColors } from '../../hooks';
import { normalizeSortField } from '../../utils/sortFiles';
import { isRemotePath } from '../../utils/format';
import { mapBackendError } from '../../utils/backendError';
import {
  pathsEligibleForLocalMove,
  runCopyToTarget,
} from './dualPaneTransfer';

const { Title, Text } = Typography;

const isAppRemotePath = (path: string) => path.startsWith('remote://');

export const DualPaneFileBrowser: React.FC = () => {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { settings } = useSettingsStore();
  const {
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
  const {
    activePane,
    setActivePane,
    leftRoot,
    rightRoot,
    leftSelection,
    rightSelection,
    setSelection,
    swapPanes,
    setLeftRoot,
    setRightRoot,
  } = useDualPaneStore();
  const { addPath } = useFileStore();
  const { startTransfer } = useTransferStore();
  const [splitRatio] = useState(50);

  const activeSelection = activePane === 'left' ? leftSelection : rightSelection;
  const activeRoot = activePane === 'left' ? leftRoot : rightRoot;
  const otherRoot = activePane === 'left' ? rightRoot : leftRoot;

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

  const runPaneTransfer = useCallback(
    async (sourcePaths: string[], targetPath: string, asMove: boolean) => {
      if (!sourcePaths.length || !targetPath) {
        message.warning(t('browser.dualPane.needSelectionAndTarget'));
        return;
      }
      if (asMove && pathsEligibleForLocalMove(sourcePaths, targetPath)) {
        try {
          const items = sourcePaths.map((path) => ({ path, op: 'move' as const }));
          const result = await invoke<{
            applied: number;
            failed: number;
            errors: string[];
          }>('apply_batch_ops', {
            items,
            dest: targetPath,
            archiveZip: false,
            conflictResolution: 'rename',
          });
          message.success(
            t('batch.applyResult', {
              applied: result.applied,
              skipped: 0,
              failed: result.failed,
            })
          );
          setSelection(activePane, []);
          return;
        } catch (err) {
          message.error(mapBackendError(err));
          return;
        }
      }
      if (asMove) {
        message.info(t('browser.dualPane.moveRemoteIsCopy'));
      }
      const check = await runCopyToTarget(sourcePaths, targetPath);
      if (check === 'none') {
        await startTransfer('rename');
      }
    },
    [activePane, setSelection, startTransfer, t]
  );

  const handleCopyToOther = () => {
    if (!otherRoot) {
      message.warning(t('browser.dualPane.otherPaneEmpty'));
      return;
    }
    void runPaneTransfer(activeSelection, otherRoot, false);
  };

  const handleMoveToOther = () => {
    if (!otherRoot) {
      message.warning(t('browser.dualPane.otherPaneEmpty'));
      return;
    }
    void runPaneTransfer(activeSelection, otherRoot, true);
  };

  const handleDropOnPane = (targetPane: 'left' | 'right', paths: string[]) => {
    const targetRoot = targetPane === 'left' ? leftRoot : rightRoot;
    if (!targetRoot) {
      message.warning(t('browser.dualPane.otherPaneEmpty'));
      return;
    }
    setActivePane(targetPane);
    void runPaneTransfer(paths, targetRoot, false);
  };

  const handleEnterSelectedFolder = () => {
    if (activeSelection.length !== 1 || !activeSelection[0]) {
      message.warning(t('browser.dualPane.enterNeedOneFolder'));
      return;
    }
    const path = activeSelection[0];
    const setRoot = activePane === 'left' ? setLeftRoot : setRightRoot;
    setRoot(path);
    void addPath(path);
    setSelection(activePane, []);
  };

  const handleDelete = () => {
    if (!activeSelection.length) {
      message.warning(t('browser.dualPane.needSelection'));
      return;
    }
    const allRemote = activeSelection.every(isAppRemotePath);
    const anyRemote = activeSelection.some(isAppRemotePath);
    if (anyRemote && !allRemote) {
      message.warning(t('browser.dualPane.deleteMixedRemote'));
      return;
    }
    const systemHit = activeSelection.some(looksLikeSystemPath);
    Modal.confirm({
      title: allRemote
        ? t('browser.dualPane.deleteRemoteTitle')
        : t('browser.dualPane.deleteConfirmTitle'),
      content: systemHit
        ? t('browser.dualPane.deleteSystemWarning')
        : allRemote
          ? t('browser.dualPane.deleteRemoteBody')
          : t('browser.dualPane.deleteConfirmBody', { count: activeSelection.length }),
      okText: t('browser.dualPane.deleteConfirmOk'),
      okType: 'danger',
      cancelText: t('browser.dualPane.deleteConfirmCancel'),
      onOk: async () => {
        try {
          if (allRemote) {
            const result = await invoke<{ deleted: number; failed: number }>('delete_remote_paths', {
              paths: activeSelection,
            });
            message.success(t('browser.dualPane.deleteRemoteResult', { count: result.deleted }));
            if (result.failed > 0) {
              message.warning(t('browser.dualPane.deleteFailed', { count: result.failed }));
            }
          } else {
            const result = await invoke<{ deleted: number; failed: number }>('trash_user_paths', {
              paths: activeSelection,
            });
            message.success(t('browser.dualPane.deleteResult', { count: result.deleted }));
            if (result.failed > 0) {
              message.warning(t('browser.dualPane.deleteFailed', { count: result.failed }));
            }
          }
          setSelection(activePane, []);
        } catch (err) {
          message.error(mapBackendError(err));
        }
      },
    });
  };

  useEffect(() => {
    if (settings.showHiddenFiles !== showHidden) {
      toggleShowHidden();
    }
    setSortField(normalizeSortField(settings.sortBy));
    setSortOrder(settings.sortOrder);
  }, [settings.showHiddenFiles, settings.sortBy, settings.sortOrder]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '16px 24px',
          borderBottom: `1px solid ${colors.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <Space>
          <FolderOpenOutlined style={{ fontSize: 24, color: colors.accentOrange }} />
          <Title level={4} style={{ margin: 0, color: colors.textPrimary }}>
            {t('browser.fileBrowser.title')}
          </Title>
          <Tag color="purple">{t('browser.dualPane.badge')}</Tag>
        </Space>
        <Space wrap>
          <Button
            size="small"
            icon={<EnterOutlined />}
            disabled={activeSelection.length !== 1}
            onClick={handleEnterSelectedFolder}
          >
            {t('browser.dualPane.enterFolder')}
          </Button>
          <Button
            size="small"
            icon={<CopyOutlined />}
            disabled={!activeSelection.length || !otherRoot}
            onClick={handleCopyToOther}
          >
            {t('browser.dualPane.copyToOther')}
          </Button>
          <Button
            size="small"
            icon={<SwapOutlined />}
            disabled={!activeSelection.length || !otherRoot}
            onClick={handleMoveToOther}
          >
            {t('browser.dualPane.moveToOther')}
          </Button>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            disabled={!activeSelection.length}
            onClick={handleDelete}
          >
            {t('browser.dualPane.deleteToTrash')}
          </Button>
          <Button size="small" icon={<SwapOutlined />} onClick={swapPanes}>
            {t('browser.dualPane.swapPanes')}
          </Button>
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
          <Space size="small">
            {showHidden ? <EyeOutlined style={{ color: colors.accentBlue }} /> : <EyeInvisibleOutlined />}
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('browser.fileBrowser.showHidden')}
            </Text>
            <Switch size="small" checked={showHidden} onChange={handleShowHiddenChange} />
          </Space>
        </Space>
      </div>

      {activeRoot && (
        <div style={{ padding: '4px 24px' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('browser.dualPane.activePane')}:{' '}
            {activePane === 'left' ? t('browser.dualPane.paneLeft') : t('browser.dualPane.paneRight')}
            {isRemotePath(activeRoot) ? ` · ${activeRoot}` : null}
            {activeSelection.length > 0 && (
              <Tag style={{ marginLeft: 8 }} color="blue">
                {t('browser.dualPane.selectedCount', { count: activeSelection.length })}
              </Tag>
            )}
          </Text>
        </div>
      )}

      {error && (
        <Alert type="error" showIcon closable message={error} style={{ margin: '8px 24px 0' }} />
      )}

      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: settings.previewPanelPosition === 'bottom' ? 'column' : 'row',
          overflow: 'hidden',
          minHeight: 0,
          padding: 12,
          gap: 8,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: settings.previewPanelPosition === 'bottom' ? 'column' : 'row',
            flex: settings.previewPanelPosition === 'bottom' ? '0 0 55%' : '0 0 50%',
            minHeight: 0,
            gap: 8,
          }}
        >
          <div style={{ flex: `1 1 ${splitRatio}%`, minWidth: 0, display: 'flex' }}>
            <BrowserPane
              side="left"
              isActive={activePane === 'left'}
              onActivate={() => setActivePane('left')}
              viewMode={viewMode === 'list' ? 'list' : 'tree'}
              onDropPaths={(paths) => handleDropOnPane('left', paths)}
            />
          </div>
          <div
            style={{
              width: settings.previewPanelPosition === 'bottom' ? '100%' : 4,
              height: settings.previewPanelPosition === 'bottom' ? 4 : 'auto',
              background: colors.border,
              borderRadius: 2,
              flexShrink: 0,
            }}
          />
          <div style={{ flex: `1 1 ${100 - splitRatio}%`, minWidth: 0, display: 'flex' }}>
            <BrowserPane
              side="right"
              isActive={activePane === 'right'}
              onActivate={() => setActivePane('right')}
              viewMode={viewMode === 'list' ? 'list' : 'tree'}
              onDropPaths={(paths) => handleDropOnPane('right', paths)}
            />
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
          <FilePreview />
        </div>
      </div>

      <ConflictModal />
    </div>
  );
};