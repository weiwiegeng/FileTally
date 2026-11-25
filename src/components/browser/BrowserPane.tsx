import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Dropdown,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CloudServerOutlined,
  FolderOpenOutlined,
  HomeOutlined,
  DownOutlined,
  UpOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { FileTree } from './FileTree';
import { FileListView } from './FileListView';
import { RemoteFolderSelector } from '../search/RemoteFolderSelector';
import { BrowserPaneProvider } from './BrowserPaneContext';
import {
  useFileStore,
  useRemoteStore,
  useDualPaneStore,
  useNavigationStore,
  type BrowserPaneSide,
} from '../../stores';
import { useThemeColors } from '../../hooks';
import { isRemotePath, getPathName } from '../../utils/format';
import { fileService } from '../../services';
import { invoke } from '@tauri-apps/api/core';
import { parentPath, isPathUnderRoot, normalizeRemotePath, pathsEqual } from '../../utils/pathNav';

const { Text } = Typography;

export interface BrowserPaneProps {
  side: BrowserPaneSide;
  isActive: boolean;
  onActivate: () => void;
  onDropPaths: (paths: string[]) => void;
  viewMode: 'tree' | 'list';
}

export const BrowserPane: React.FC<BrowserPaneProps> = ({
  side,
  isActive,
  onActivate,
  onDropPaths,
  viewMode,
}) => {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { connections } = useRemoteStore();
  const { addPath } = useFileStore();
  const root = useDualPaneStore((s) => (side === 'left' ? s.leftRoot : s.rightRoot));
  const cwd = useDualPaneStore((s) => (side === 'left' ? s.leftCwd : s.rightCwd));
  const selection = useDualPaneStore((s) => (side === 'left' ? s.leftSelection : s.rightSelection));
  const anchor = useDualPaneStore((s) => (side === 'left' ? s.leftAnchor : s.rightAnchor));
  const expandedIds = useDualPaneStore((s) =>
    side === 'left' ? s.leftExpandedIds : s.rightExpandedIds
  );
  const setSelection = useDualPaneStore((s) => s.setSelection);
  const setRoot = useDualPaneStore((s) =>
    side === 'left' ? s.setLeftRoot : s.setRightRoot
  );
  const setCwd = useDualPaneStore((s) => s.setCwd);
  const setAnchor = useDualPaneStore((s) => s.setAnchor);
  const toggleExpanded = useDualPaneStore((s) => s.toggleExpanded);

  const [showRemoteSelector, setShowRemoteSelector] = useState(false);
  const [visiblePaths, setVisiblePaths] = useState<string[]>([]);

  const listPath = cwd ?? root;

  useEffect(() => {
    if (root) {
      void addPath(root);
    }
  }, [root, addPath]);

  const selectRange = useCallback(
    (target: string, ordered: string[]) => {
      const a = anchor ?? selection[0] ?? target;
      const i1 = ordered.indexOf(a);
      const i2 = ordered.indexOf(target);
      if (i1 < 0 || i2 < 0) {
        setSelection(side, [target]);
        setAnchor(side, target);
        return;
      }
      const [lo, hi] = i1 < i2 ? [i1, i2] : [i2, i1];
      setSelection(side, ordered.slice(lo, hi + 1));
      setAnchor(side, a);
    },
    [anchor, selection, setAnchor, setSelection, side]
  );

  const onSelectPath = useCallback(
    (path: string, opts?: { additive?: boolean; range?: boolean; visiblePaths?: string[] }) => {
      const ordered = opts?.visiblePaths ?? visiblePaths;
      if (opts?.range) {
        selectRange(path, ordered);
        return;
      }
      if (opts?.additive) {
        const next = selection.includes(path)
          ? selection.filter((p) => p !== path)
          : [...selection, path];
        setSelection(side, next);
        if (!selection.includes(path)) setAnchor(side, path);
      } else {
        setSelection(side, [path]);
        setAnchor(side, path);
      }
    },
    [selection, setSelection, setAnchor, side, visiblePaths, selectRange]
  );

  const enterFolder = useCallback(
    (path: string) => {
      if (!root || !isPathUnderRoot(root, path)) return;
      const next = path.startsWith('remote://') ? normalizeRemotePath(path) : path;
      if (pathsEqual(next, root)) {
        setCwd(side, null);
        return;
      }
      setCwd(side, next);
      void fileService.scanDirectory(next).catch(() => undefined);
    },
    [root, setCwd, side]
  );

  const goUp = useCallback(() => {
    if (!root) return;
    if (cwd) {
      const parent = parentPath(cwd);
      if (parent && isPathUnderRoot(root, parent)) {
        setCwd(side, pathsEqual(parent, root) ? null : parent);
      } else {
        setCwd(side, null);
      }
      return;
    }
    const parent = parentPath(root);
    if (parent) {
      const next = parent.startsWith('remote://') ? normalizeRemotePath(parent) : parent;
      setRoot(next);
      void addPath(next);
    }
  }, [root, cwd, setCwd, side, setRoot, addPath]);

  const paneToggleExpand = useCallback(
    (nodeId: string) => toggleExpanded(side, nodeId),
    [side, toggleExpanded]
  );

  const paneSelection = useMemo(
    () => ({
      pane: side,
      selectedPaths: selection,
      onSelectPath,
      enableDrag: selection.length > 0,
      previewActive: isActive,
      expandedIds,
      toggleExpand: paneToggleExpand,
      cwd,
      enterFolder,
      goUp,
      setVisiblePaths,
    }),
    [
      side,
      selection,
      onSelectPath,
      isActive,
      expandedIds,
      paneToggleExpand,
      cwd,
      enterFolder,
      goUp,
    ]
  );

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (!isActive) onActivate();
    const raw =
      e.dataTransfer.getData('application/json') ||
      e.dataTransfer.getData('text/plain');
    if (!raw) return;
    try {
      const paths = JSON.parse(raw) as string[];
      if (Array.isArray(paths) && paths.length) onDropPaths(paths);
    } catch {
      /* ignore */
    }
  };

  const borderColor = isActive ? colors.accentBlue : colors.border;
  const canGoUp = Boolean(cwd || (root && parentPath(root)));

  const breadcrumb = listPath ? getPathName(listPath) : '';

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
        overflow: 'hidden',
        background: isActive ? 'transparent' : colors.bgSecondary,
      }}
      onMouseDown={onActivate}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        style={{
          padding: '8px 12px',
          borderBottom: `1px solid ${colors.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Tag color={side === 'left' ? 'blue' : 'green'}>
          {side === 'left' ? t('browser.dualPane.paneLeft') : t('browser.dualPane.paneRight')}
        </Tag>
        {root ? (
          <Tooltip title={listPath || root}>
            <Text ellipsis style={{ flex: 1, fontSize: 12 }}>
              {isRemotePath(root) ? <CloudServerOutlined style={{ marginRight: 4 }} /> : null}
              {listPath || root}
            </Text>
          </Tooltip>
        ) : (
          <Text type="secondary" style={{ flex: 1, fontSize: 12 }}>
            {t('browser.fileBrowser.emptyHint')}
          </Text>
        )}
        {root && viewMode === 'list' ? (
          <Space size={4}>
            <Button
              size="small"
              icon={<UpOutlined />}
              disabled={!canGoUp}
              onClick={goUp}
              title={t('browser.dualPane.goUp')}
            />
            {cwd ? (
              <Tag style={{ margin: 0 }}>{breadcrumb}</Tag>
            ) : null}
          </Space>
        ) : null}
        <Dropdown
          menu={{
            items: [
              {
                key: 'local',
                label: t('browser.fileBrowser.localFolder'),
                icon: <FolderOpenOutlined />,
                onClick: () => {
                  void fileService.pickDirectory().then((picked) => {
                    if (picked) {
                      setRoot(picked);
                      void addPath(picked);
                    }
                  });
                },
              },
              {
                key: 'home',
                label: t('browser.fileBrowser.homeFolder'),
                icon: <HomeOutlined />,
                onClick: () => {
                  void invoke<string>('get_home_dir').then((home) => {
                    if (home) {
                      setRoot(home);
                      void addPath(home);
                    }
                  });
                },
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
          <Button size="small" type={root ? 'default' : 'primary'}>
            <Space size={4}>
              <FolderOpenOutlined />
              <DownOutlined style={{ fontSize: 10 }} />
            </Space>
          </Button>
        </Dropdown>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 8, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {root ? (
          <BrowserPaneProvider value={paneSelection}>
            {viewMode === 'list' ? (
              <FileListView rootPath={root} listPath={listPath || root} />
            ) : (
              <FileTree rootPath={root} />
            )}
          </BrowserPaneProvider>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              gap: 12,
              padding: 16,
              textAlign: 'center',
            }}
          >
            <FolderOpenOutlined style={{ fontSize: 48, color: colors.border }} />
            <Text type="secondary">{t('browser.fileBrowser.emptyPaneHint')}</Text>
            <Space wrap style={{ justifyContent: 'center' }}>
              <Button
                type="primary"
                icon={<FolderOpenOutlined />}
                onClick={() => {
                  void fileService.pickDirectory().then((picked) => {
                    if (picked) {
                      setRoot(picked);
                      void addPath(picked);
                    }
                  });
                }}
              >
                {t('browser.fileBrowser.pickLocal')}
              </Button>
              <Button
                icon={<HomeOutlined />}
                onClick={() => {
                  void invoke<string>('get_home_dir').then((home) => {
                    if (home) {
                      setRoot(home);
                      void addPath(home);
                    }
                  });
                }}
              >
                {t('browser.fileBrowser.homeFolder')}
              </Button>
              <Button
                icon={<CloudServerOutlined />}
                onClick={() => {
                  if (connections.length === 0) {
                    useNavigationStore.getState().openMenu('remote');
                    return;
                  }
                  setShowRemoteSelector(true);
                }}
              >
                {connections.length === 0
                  ? t('browser.fileBrowser.addRemoteConnection')
                  : t('browser.fileBrowser.pickRemote')}
              </Button>
            </Space>
          </div>
        )}
      </div>

      <RemoteFolderSelector
        open={showRemoteSelector}
        onClose={() => setShowRemoteSelector(false)}
        onSelect={(path) => {
          setRoot(path);
          void addPath(path);
          setShowRemoteSelector(false);
        }}
      />
    </div>
  );
};