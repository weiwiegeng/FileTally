import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Typography,
  Space,
  Select,
  Tag,
  Tooltip,
  Alert,
  message,
  Modal,
  Input,
  Dropdown,
  Divider,
  Segmented,
} from 'antd';
import type { MenuProps } from 'antd';
import {
  FolderOpenOutlined,
  EyeOutlined,
  EyeInvisibleOutlined,
  CopyOutlined,
  SwapOutlined,
  DeleteOutlined,
  UnorderedListOutlined,
  ApartmentOutlined,
  EnterOutlined,
  UploadOutlined,
  FolderAddOutlined,
  EditOutlined,
  MoreOutlined,
  ColumnWidthOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  useFileStore,
  useSettingsStore,
  useDualPaneStore,
  useTransferStore,
  useNavigationStore,
} from '../../stores';
import { looksLikeSystemPath, parentPath } from '../../utils/pathNav';
import { BrowserPane } from './BrowserPane';
import { BrowserPlacesBar } from './BrowserPlacesBar';
import { FilePreview } from './FilePreview';
import { ConflictModal } from '../transfer/ConflictModal';
import { useThemeColors } from '../../hooks';
import { normalizeSortField } from '../../utils/sortFiles';
import { mapBackendError } from '../../utils/backendError';
import {
  pathsEligibleForLocalMove,
  runCopyToTarget,
} from './dualPaneTransfer';

const { Title, Text } = Typography;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

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
  const { addPath, invalidatePaths } = useFileStore();
  const { startTransfer, setPendingDeleteSources } = useTransferStore();
  const openTransferWith = useNavigationStore((s) => s.openTransferWith);
  const openMenu = useNavigationStore((s) => s.openMenu);
  const renameFile = useFileStore((s) => s.renameFile);
  const [splitRatio] = useState(50);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState('');

  const leftCwd = useDualPaneStore((s) => s.leftCwd);
  const rightCwd = useDualPaneStore((s) => s.rightCwd);
  const transferring = useTransferStore((s) => s.transferring);
  const wasTransferring = useRef(false);

  const activeSelection = activePane === 'left' ? leftSelection : rightSelection;
  const activeRoot = activePane === 'left' ? leftRoot : rightRoot;
  const otherRoot = activePane === 'left' ? rightRoot : leftRoot;
  const otherTarget =
    (activePane === 'left' ? rightCwd : leftCwd) || otherRoot;

  const targetForPane = useCallback(
    (pane: 'left' | 'right') =>
      (pane === 'left' ? leftCwd : rightCwd) || (pane === 'left' ? leftRoot : rightRoot),
    [leftCwd, leftRoot, rightCwd, rightRoot]
  );

  const refreshAfterMutation = useCallback(
    (extra: string[] = []) => {
      const dual = useDualPaneStore.getState();
      const paths = [
        dual.leftRoot,
        dual.rightRoot,
        dual.leftCwd,
        dual.rightCwd,
        ...extra,
      ].filter((p): p is string => Boolean(p));
      void invalidatePaths(paths);
    },
    [invalidatePaths]
  );

  // Conflict modal / queued jobs finish outside runPaneTransfer — refresh when a transfer settles.
  useEffect(() => {
    if (wasTransferring.current && !transferring) {
      const { targetPath, sourceItems, result } = useTransferStore.getState();
      if (result && !result.cancelled) {
        refreshAfterMutation([
          ...(targetPath ? [targetPath] : []),
          ...sourceItems
            .map((item) => parentPath(item.sourcePath))
            .filter((p): p is string => Boolean(p)),
        ]);
      }
    }
    wasTransferring.current = transferring;
  }, [transferring, refreshAfterMutation]);

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
          refreshAfterMutation([
            targetPath,
            ...sourcePaths.map((p) => parentPath(p)).filter((p): p is string => Boolean(p)),
          ]);
          return;
        } catch (err) {
          message.error(mapBackendError(err));
          return;
        }
      }
      if (asMove) {
        message.info(t('browser.dualPane.moveRemoteIsCopy'));
        setPendingDeleteSources(sourcePaths);
      } else {
        setPendingDeleteSources(null);
      }
      const check = await runCopyToTarget(sourcePaths, targetPath);
      if (check === 'none') {
        openMenu('tasks');
        message.info(t('browser.dualPane.transferStarted'));
        await startTransfer('rename');
        setSelection(activePane, []);
      } else if (check === 'conflicts') {
        openMenu('tasks');
      }
    },
    [
      activePane,
      openMenu,
      refreshAfterMutation,
      setPendingDeleteSources,
      setSelection,
      startTransfer,
      t,
    ]
  );

  const handleSendToTransfer = () => {
    if (!activeSelection.length) {
      message.warning(t('browser.dualPane.needSelection'));
      return;
    }
    openTransferWith(activeSelection, otherTarget || undefined);
  };

  const handleCopyToOther = () => {
    if (!otherTarget) {
      message.warning(t('browser.dualPane.otherPaneEmpty'));
      return;
    }
    void runPaneTransfer(activeSelection, otherTarget, false);
  };

  const handleMoveToOther = () => {
    if (!otherTarget) {
      message.warning(t('browser.dualPane.otherPaneEmpty'));
      return;
    }
    void runPaneTransfer(activeSelection, otherTarget, true);
  };

  const handleDropOnPane = (targetPane: 'left' | 'right', paths: string[]) => {
    const dest = targetForPane(targetPane);
    if (!dest) {
      message.warning(t('browser.dualPane.otherPaneEmpty'));
      return;
    }
    setActivePane(targetPane);
    void runPaneTransfer(paths, dest, false);
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
          refreshAfterMutation(
            activeSelection
              .map((p) => parentPath(p))
              .filter((p): p is string => Boolean(p))
          );
        } catch (err) {
          message.error(mapBackendError(err));
        }
      },
    });
  };

  const deleteIsRemote =
    activeSelection.length > 0 && activeSelection.every(isAppRemotePath);

  const activeCwd =
    (activePane === 'left' ? leftCwd : rightCwd) || activeRoot;

  const handleNewFolder = () => {
    if (!activeCwd) {
      message.warning(t('browser.dualPane.needActiveFolder'));
      return;
    }
    setMkdirName(t('browser.dualPane.newFolderDefault'));
    setMkdirOpen(true);
  };

  const confirmNewFolder = async () => {
    const name = mkdirName.trim();
    if (!name || !activeCwd) {
      setMkdirOpen(false);
      return;
    }
    try {
      await invoke<string>('mkdir_path', { parent: activeCwd, name });
      message.success(t('browser.dualPane.mkdirSuccess'));
      setMkdirOpen(false);
      refreshAfterMutation([activeCwd]);
    } catch (err) {
      message.error(mapBackendError(err));
    }
  };

  const handleRename = () => {
    if (activeSelection.length !== 1 || !activeSelection[0]) {
      message.warning(t('browser.dualPane.renameNeedOne'));
      return;
    }
    const path = activeSelection[0];
    const base = path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '';
    setRenameName(base);
    setRenameOpen(true);
  };

  const confirmRename = async () => {
    const path = activeSelection[0];
    const name = renameName.trim();
    if (!path || !name) {
      setRenameOpen(false);
      return;
    }
    const result = await renameFile(path, name);
    if (result.success) {
      message.success(t('browser.fileTreeNode.renameSuccess'));
      setRenameOpen(false);
      setSelection(activePane, []);
      refreshAfterMutation([parentPath(path)].filter((p): p is string => Boolean(p)));
    } else {
      message.error(
        result.error ? mapBackendError(result.error) : t('browser.fileTreeNode.renameFailed')
      );
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || mkdirOpen || renameOpen) return;
      const meta = e.metaKey || e.ctrlKey;
      if (e.key === 'Tab' && !meta && !e.altKey) {
        e.preventDefault();
        setActivePane(activePane === 'left' ? 'right' : 'left');
        return;
      }
      if (e.key === 'F5') {
        e.preventDefault();
        refreshAfterMutation();
        return;
      }
      if (e.key === 'F2') {
        e.preventDefault();
        handleRename();
        return;
      }
      if (e.key === 'Delete' || (e.key === 'Backspace' && meta)) {
        e.preventDefault();
        handleDelete();
        return;
      }
      if (e.key === 'Enter' && !meta) {
        e.preventDefault();
        handleEnterSelectedFolder();
        return;
      }
      if (meta && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        handleCopyToOther();
        return;
      }
      if (meta && e.key.toLowerCase() === 'x') {
        e.preventDefault();
        handleMoveToOther();
        return;
      }
      if (meta && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        handleNewFolder();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // Handlers close over latest pane/selection; rebind when those inputs change.
  }, [
    activePane,
    activeSelection,
    otherTarget,
    mkdirOpen,
    renameOpen,
    refreshAfterMutation,
    setActivePane,
  ]);

  useEffect(() => {
    if (settings.showHiddenFiles !== showHidden) {
      toggleShowHidden();
    }
    setSortField(normalizeSortField(settings.sortBy));
    setSortOrder(settings.sortOrder);
  }, [settings.showHiddenFiles, settings.sortBy, settings.sortOrder]);

  const moreMenuItems: MenuProps['items'] = useMemo(
    () => [
      {
        key: 'enter',
        icon: <EnterOutlined />,
        label: t('browser.dualPane.enterFolder'),
        disabled: activeSelection.length !== 1,
        onClick: () => handleEnterSelectedFolder(),
      },
      {
        key: 'rename',
        icon: <EditOutlined />,
        label: t('browser.dualPane.rename'),
        disabled: activeSelection.length !== 1,
        onClick: () => handleRename(),
      },
      {
        key: 'mkdir',
        icon: <FolderAddOutlined />,
        label: t('browser.dualPane.newFolder'),
        disabled: !activeCwd,
        onClick: () => handleNewFolder(),
      },
      { type: 'divider' },
      {
        key: 'send',
        icon: <UploadOutlined />,
        label: t('browser.dualPane.sendToTransfer'),
        disabled: !activeSelection.length,
        onClick: () => handleSendToTransfer(),
      },
      {
        key: 'swap',
        icon: <ColumnWidthOutlined />,
        label: t('browser.dualPane.swapPanes'),
        onClick: () => swapPanes(),
      },
    ],
    // handlers close over latest selection/cwd
    [activeSelection.length, activeCwd, t]
  );

  return (
    <div
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        style={{
          padding: '10px 16px',
          borderBottom: `1px solid ${colors.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <Space size={8} style={{ marginRight: 'auto' }}>
          <FolderOpenOutlined style={{ fontSize: 18, color: colors.accentOrange }} />
          <Title level={5} style={{ margin: 0, color: colors.textPrimary, fontWeight: 600 }}>
            {t('browser.fileBrowser.title')}
          </Title>
          {activeSelection.length > 0 ? (
            <Tag style={{ margin: 0 }} color="blue">
              {t('browser.dualPane.selectedCount', { count: activeSelection.length })}
            </Tag>
          ) : null}
        </Space>

        <Space size={6} wrap>
          <Tooltip title={t('browser.dualPane.copyToOther')}>
            <Button
              size="small"
              type="primary"
              icon={<CopyOutlined />}
              disabled={!activeSelection.length || !otherTarget}
              onClick={handleCopyToOther}
            >
              {t('browser.dualPane.copyShort')}
            </Button>
          </Tooltip>
          <Tooltip title={t('browser.dualPane.moveToOther')}>
            <Button
              size="small"
              icon={<SwapOutlined />}
              disabled={!activeSelection.length || !otherTarget}
              onClick={handleMoveToOther}
            >
              {t('browser.dualPane.moveShort')}
            </Button>
          </Tooltip>
          <Tooltip
            title={
              deleteIsRemote
                ? t('browser.dualPane.deleteRemoteAction')
                : t('browser.dualPane.deleteToTrash')
            }
          >
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              disabled={!activeSelection.length}
              onClick={handleDelete}
            >
              {t('browser.dualPane.deleteShort')}
            </Button>
          </Tooltip>

          <Divider type="vertical" style={{ margin: '0 2px', height: 22 }} />

          <Dropdown menu={{ items: moreMenuItems }} trigger={['click']}>
            <Tooltip title={t('browser.dualPane.hotkeysHint')}>
              <Button size="small" icon={<MoreOutlined />}>
                {t('browser.dualPane.moreActions')}
              </Button>
            </Tooltip>
          </Dropdown>

          <Divider type="vertical" style={{ margin: '0 2px', height: 22 }} />

          <Segmented
            size="small"
            value={viewMode === 'list' ? 'list' : 'tree'}
            onChange={(v) => setViewMode(v === 'list' ? 'list' : 'tree')}
            options={[
              {
                value: 'tree',
                icon: <ApartmentOutlined />,
                title: t('browser.fileBrowser.viewTree'),
              },
              {
                value: 'list',
                icon: <UnorderedListOutlined />,
                title: t('browser.fileBrowser.viewList'),
              },
            ]}
          />
          <Select
            size="small"
            value={`${sortField}:${sortOrder}`}
            onChange={(v) => {
              const [field, order] = String(v).split(':') as [string, 'asc' | 'desc'];
              handleSortFieldChange(field);
              handleSortOrderChange(order);
            }}
            style={{ width: 118 }}
            options={[
              {
                label: `${t('browser.fileBrowser.sortByName')} ↑`,
                value: 'name:asc',
              },
              {
                label: `${t('browser.fileBrowser.sortByName')} ↓`,
                value: 'name:desc',
              },
              {
                label: `${t('browser.fileBrowser.sortBySize')} ↑`,
                value: 'size:asc',
              },
              {
                label: `${t('browser.fileBrowser.sortBySize')} ↓`,
                value: 'size:desc',
              },
              {
                label: `${t('browser.fileBrowser.sortByDate')} ↑`,
                value: 'modified_time:asc',
              },
              {
                label: `${t('browser.fileBrowser.sortByDate')} ↓`,
                value: 'modified_time:desc',
              },
            ]}
          />
          <Tooltip
            title={
              showHidden
                ? t('browser.dualPane.hideHidden')
                : t('browser.dualPane.showHiddenFiles')
            }
          >
            <Button
              size="small"
              type={showHidden ? 'primary' : 'default'}
              ghost={showHidden}
              icon={showHidden ? <EyeOutlined /> : <EyeInvisibleOutlined />}
              onClick={() => handleShowHiddenChange(!showHidden)}
            />
          </Tooltip>
        </Space>
      </div>

      <BrowserPlacesBar />

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
        onContextMenu={(e) => e.preventDefault()}
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

      <Modal
        title={t('browser.dualPane.newFolder')}
        open={mkdirOpen}
        onOk={() => void confirmNewFolder()}
        onCancel={() => setMkdirOpen(false)}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        destroyOnClose
      >
        <Input
          autoFocus
          value={mkdirName}
          onChange={(e) => setMkdirName(e.target.value)}
          onPressEnter={() => void confirmNewFolder()}
          placeholder={t('browser.dualPane.newFolderDefault')}
        />
      </Modal>

      <Modal
        title={t('browser.dualPane.rename')}
        open={renameOpen}
        onOk={() => void confirmRename()}
        onCancel={() => setRenameOpen(false)}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        destroyOnClose
      >
        <Input
          autoFocus
          value={renameName}
          onChange={(e) => setRenameName(e.target.value)}
          onPressEnter={() => void confirmRename()}
        />
      </Modal>
    </div>
  );
};