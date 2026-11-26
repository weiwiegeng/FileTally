import React, { useEffect, useRef, useState } from 'react';
import {
  Card,
  Space,
  Button,
  Select,
  Input,
  Table,
  Typography,
  Tag,
  message,
  Progress,
  Radio,
  Tooltip,
  Statistic,
  Row,
  Col,
  Alert,
  Tree,
  Spin,
  Modal,
  Popconfirm,
} from 'antd';
import {
  FileExcelOutlined,
  FolderOpenOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloudOutlined,
  SearchOutlined,
  FileOutlined,
  FolderOutlined,
  SaveOutlined,
  DeleteOutlined,
  SettingOutlined,
  StopOutlined,
  PlusOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
} from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { mapBackendError } from '../../utils/backendError';
import { RemoteFolderSelector } from '../search/RemoteFolderSelector';
import {
  useCheckConfigStore,
  templatesToRules,
  rulesToTemplates,
  type CheckRule,
  type ScopeKind,
} from '../../stores';

const { Title, Text } = Typography;

interface ExcelColumnInfo {
  index: number;
  name: string;
  letter: string;
  sampleValues: string[];
}

interface ExcelFileInfo {
  sheets: string[];
  columns: ExcelColumnInfo[];
  rowCount: number;
}

interface RuleOutcome {
  ruleType: string;
  label: string;
  expectedName: string;
  ok: boolean;
  foundPath?: string | null;
  flagged: boolean;
}

interface MaterialCheckItem {
  rowIndex: number;
  name: string;
  bound: boolean;
  boundPath: string | null;
  isComplete: boolean;
  outcomes: RuleOutcome[];
  flags: string[];
}

interface MaterialCheckResult {
  totalRows: number;
  completeCount: number;
  incompleteCount: number;
  notFoundCount: number;
  flaggedCount: number;
  items: MaterialCheckItem[];
  outputPath: string | null;
  truncated?: boolean;
  cancelled?: boolean;
  scope: ScopeKind;
}

interface FileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileTreeNode[];
}

interface FolderTreeResult {
  root: FileTreeNode;
  totalFiles: number;
  totalFolders: number;
  truncated?: boolean;
}

interface TreeDataNode {
  key: string;
  title: React.ReactNode;
  icon?: React.ReactNode;
  children?: TreeDataNode[];
  isLeaf?: boolean;
}

interface ExcelCheckProgress {
  jobId: number;
  stage: string;
  current: number;
  total: number;
  message: string;
}

const PRESET_OPTIONS = [
  { id: 'dossier_complete', labelKey: 'excel.smart.presetDossier' },
  { id: 'flat_reconcile', labelKey: 'excel.smart.presetFlat' },
  { id: 'exists_only', labelKey: 'excel.smart.presetExists' },
  { id: 'flat_exists', labelKey: 'excel.smart.presetFlatExists' },
  { id: 'recursive_reconcile', labelKey: 'excel.smart.presetRecursive' },
  { id: 'custom', labelKey: 'excel.smart.customPreset' },
] as const;

const PRESET_DEFAULTS: Record<
  string,
  { scope: ScopeKind; rules: CheckRule[]; matchMode: string }
> = {
  dossier_complete: {
    scope: 'person_folders',
    matchMode: 'contains',
    rules: [
      { type: 'require', pattern: '{name}.docx' },
      { type: 'require', pattern: '{name}照片' },
      { type: 'require', pattern: '司法鉴定意见书.docx' },
    ],
  },
  flat_reconcile: {
    scope: 'flat_files',
    matchMode: 'contains',
    rules: [{ type: 'flag_contains', needle: '缺病例', label: '缺病例' }],
  },
  exists_only: {
    scope: 'person_folders',
    matchMode: 'contains',
    rules: [],
  },
  flat_exists: {
    scope: 'flat_files',
    matchMode: 'contains',
    rules: [],
  },
  recursive_reconcile: {
    scope: 'recursive_files',
    matchMode: 'contains',
    rules: [{ type: 'flag_contains', needle: '缺', label: '名称含「缺」' }],
  },
};

export const ExcelCheck: React.FC = () => {
  const { t } = useTranslation();

  const [excelPath, setExcelPath] = useState('');
  const [excelInfo, setExcelInfo] = useState<ExcelFileInfo | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [nameColumn, setNameColumn] = useState<number | null>(null);
  const [folderMatchMode, setFolderMatchMode] = useState('contains');

  const [targetFolder, setTargetFolder] = useState('');
  const [isRemote, setIsRemote] = useState(false);
  const [folderTree, setFolderTree] = useState<TreeDataNode[] | null>(null);
  const [treeInfo, setTreeInfo] = useState<{ files: number; folders: number } | null>(null);
  const [scanningTree, setScanningTree] = useState(false);

  const [presetId, setPresetId] = useState<string>('dossier_complete');
  const [scope, setScope] = useState<ScopeKind>('person_folders');
  const [rules, setRules] = useState<CheckRule[]>(() =>
    templatesToRules(i18n.t('excel.defaults.sampleTemplates').split('\n').filter(Boolean))
  );

  const [result, setResult] = useState<MaterialCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkProgress, setCheckProgress] = useState<ExcelCheckProgress | null>(null);
  const [progressStartedAt, setProgressStartedAt] = useState<number | null>(null);
  const activeJobIdRef = useRef<number | null>(null);

  const [remoteSelectorVisible, setRemoteSelectorVisible] = useState(false);

  const { configs, addConfig, updateConfig, deleteConfig, selectConfig, selectedConfigId } =
    useCheckConfigStore();
  const [saveConfigModalVisible, setSaveConfigModalVisible] = useState(false);
  const [configName, setConfigName] = useState('');
  const [editingConfigId, setEditingConfigId] = useState<string | null>(null);

  const applyPreset = (id: string) => {
    setPresetId(id);
    const def = PRESET_DEFAULTS[id];
    if (!def) return;
    setScope(def.scope);
    setRules(def.rules.map((r) => ({ ...r })));
    setFolderMatchMode(def.matchMode);
  };

  const convertToTreeData = (node: FileTreeNode): TreeDataNode | null => {
    if (node.name.startsWith('.')) return null;
    const children = (node.children || [])
      .map(convertToTreeData)
      .filter((c): c is TreeDataNode => Boolean(c));
    return {
      key: node.path,
      title: node.name,
      icon: node.isDir ? <FolderOutlined /> : <FileOutlined />,
      isLeaf: !node.isDir,
      children: children.length ? children : undefined,
    };
  };

  const scanFolderTree = async (folderPath: string) => {
    setScanningTree(true);
    try {
      const scanned = await invoke<FolderTreeResult>('scan_folder_tree', {
        folderPath,
        maxDepth: 8,
      });
      setFolderTree(
        (scanned.root.children || [])
          .map(convertToTreeData)
          .filter((c): c is TreeDataNode => Boolean(c))
      );
      setTreeInfo({ files: scanned.totalFiles, folders: scanned.totalFolders });
      if (scanned.truncated) {
        message.warning(t('excel.messages.truncatedWarning'));
      }
    } catch (error) {
      message.error(t('excel.messages.scanTreeFailed', { error: mapBackendError(error) }));
    } finally {
      setScanningTree(false);
    }
  };

  const handleLoadConfig = (configId: string) => {
    const config = configs.find((c) => c.id === configId);
    if (!config) return;
    setTargetFolder(config.targetFolder);
    const loadedRules =
      config.rules && config.rules.length > 0
        ? config.rules
        : templatesToRules(config.templates || []);
    setRules(loadedRules);
    if (config.scope) setScope(config.scope);
    if (config.presetId) setPresetId(config.presetId);
    else setPresetId('custom');
    if (config.matchMode) setFolderMatchMode(config.matchMode);
    if (config.excelPath) {
      void (async () => {
        try {
          const info = await invoke<ExcelFileInfo>('read_excel_info', {
            filePath: config.excelPath,
            sheetIndex: 0,
          });
          setExcelPath(config.excelPath!);
          setExcelInfo(info);
          setSheetIndex(0);
          setNameColumn(config.matchColumn ?? null);
        } catch {
          /* ignore */
        }
      })();
    }
    selectConfig(configId);
    if (config.targetFolder) void scanFolderTree(config.targetFolder);
    message.success(t('excel.config.loaded', { name: config.name }));
  };

  const handleSaveConfig = () => {
    if (!configName.trim()) {
      message.warning(t('excel.config.nameRequired'));
      return;
    }
    const payload = {
      name: configName,
      targetFolder,
      templates: rulesToTemplates(rules),
      rules,
      scope,
      presetId,
      namePattern: 'auto',
      matchMode: folderMatchMode,
      excelPath: excelPath || undefined,
      matchColumn: nameColumn ?? undefined,
      kind: 'integrity' as const,
    };
    if (editingConfigId) {
      updateConfig(editingConfigId, payload);
      message.success(t('excel.config.updated'));
    } else {
      const id = addConfig(payload);
      selectConfig(id);
      message.success(t('excel.config.saved'));
    }
    setSaveConfigModalVisible(false);
    setConfigName('');
    setEditingConfigId(null);
  };

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen<ExcelCheckProgress>('excel-check-progress', (event) => {
      const p = event.payload;
      if (activeJobIdRef.current != null && p.jobId !== activeJobIdRef.current) return;
      setCheckProgress(p);
      setProgressStartedAt((prev) => prev ?? Date.now());
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const formatEta = (current: number, total: number, startedAt: number | null) => {
    if (!startedAt || total <= 0 || current <= 0) return null;
    const elapsed = (Date.now() - startedAt) / 1000;
    const remain = Math.max(0, Math.round((elapsed / current) * (total - current)));
    if (remain < 60) return t('excel.progress.etaSeconds', { seconds: remain });
    return t('excel.progress.etaMinutes', { minutes: Math.ceil(remain / 60) });
  };

  const beginCheckJob = async () => {
    const jobId = await invoke<number>('prepare_job', { kind: 'excel' });
    activeJobIdRef.current = jobId;
    setCheckProgress({ jobId, stage: 'preparing', current: 0, total: 0, message: '' });
    setProgressStartedAt(Date.now());
    return jobId;
  };

  const finishCheckJob = () => {
    activeJobIdRef.current = null;
    setCheckProgress(null);
    setProgressStartedAt(null);
  };

  const handleCancelCheck = async () => {
    const jobId = activeJobIdRef.current;
    if (!jobId) return;
    try {
      await (await import('../../utils/jobs')).cancelJob(jobId, 'excel');
      message.info(t('excel.messages.cancelRequested'));
    } catch (error) {
      message.error(t('excel.messages.cancelFailed', { error: mapBackendError(error) }));
    }
  };

  const handleSelectExcel = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: t('excel.filterExcel'), extensions: ['xlsx', 'xls'] }],
      });
      if (!selected) return;
      setExcelPath(selected as string);
      setResult(null);
      const info = await invoke<ExcelFileInfo>('read_excel_info', {
        filePath: selected,
        sheetIndex: 0,
      });
      setExcelInfo(info);
      setSheetIndex(0);
      setNameColumn(null);
    } catch (error) {
      message.error(t('excel.messages.openFileFailed', { error: mapBackendError(error) }));
    }
  };

  const handleSheetChange = async (next: number) => {
    if (!excelPath) return;
    try {
      const info = await invoke<ExcelFileInfo>('read_excel_info', {
        filePath: excelPath,
        sheetIndex: next,
      });
      setExcelInfo(info);
      setSheetIndex(next);
      setNameColumn(null);
    } catch (error) {
      message.error(t('excel.messages.readSheetFailed', { error: mapBackendError(error) }));
    }
  };

  const handleSelectFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected) return;
      const folderPath = selected as string;
      setTargetFolder(folderPath);
      setIsRemote(false);
      setFolderTree(null);
      setTreeInfo(null);
      setResult(null);
      void scanFolderTree(folderPath);
    } catch (error) {
      message.error(t('excel.messages.selectFolderFailed', { error: mapBackendError(error) }));
    }
  };

  const handleRemoteSelect = (path: string) => {
    setTargetFolder(path);
    setIsRemote(true);
    setFolderTree(null);
    setTreeInfo(null);
    setResult(null);
    void scanFolderTree(path);
    setRemoteSelectorVisible(false);
  };

  const updateRule = (index: number, next: CheckRule) => {
    setPresetId('custom');
    setRules((prev) => prev.map((r, i) => (i === index ? next : r)));
  };

  const moveRule = (index: number, dir: -1 | 1) => {
    setPresetId('custom');
    setRules((prev) => {
      const j = index + dir;
      if (j < 0 || j >= prev.length) return prev;
      const copy = [...prev];
      [copy[index], copy[j]] = [copy[j], copy[index]];
      return copy;
    });
  };

  const handleRun = async () => {
    if (!excelPath || nameColumn === null || !targetFolder) {
      message.warning(t('excel.messages.integrityPrerequisiteExcel'));
      return;
    }
    setChecking(true);
    try {
      const outputPath = await save({
        defaultPath: excelPath.replace(/\.xlsx?$/i, t('excel.defaults.integrityOutputSuffix')),
        filters: [{ name: t('excel.filterExcel'), extensions: ['xlsx'] }],
      });
      const jobId = await beginCheckJob();
      const next = await invoke<MaterialCheckResult>('run_material_check', {
        excelPath,
        sheetIndex,
        nameColumnIndex: nameColumn,
        targetFolder,
        scope,
        matchMode: folderMatchMode,
        rules,
        presetId: presetId === 'custom' ? null : presetId,
        outputPath: outputPath || null,
        jobId,
      });
      setResult(next);
      if (next.cancelled) {
        message.warning(t('excel.messages.checkCancelled'));
      } else if (next.truncated) {
        message.warning(t('excel.messages.truncatedWarning'));
      }
      if (next.outputPath) {
        message.success(t('excel.messages.checkDoneAnnotated', { path: next.outputPath }));
      } else if (!next.cancelled) {
        message.success(t('excel.messages.checkDone'));
      }
    } catch (error) {
      message.error(t('excel.messages.checkFailed', { error: mapBackendError(error) }));
    } finally {
      setChecking(false);
      finishCheckJob();
    }
  };

  const requireOutcomes = (item: MaterialCheckItem) =>
    item.outcomes.filter((o) => o.ruleType === 'require');

  return (
    <div
      style={{
        padding: 16,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <Title level={4} style={{ marginBottom: 8, flexShrink: 0 }}>
        <FileExcelOutlined /> {t('excel.pageTitle')}
      </Title>
      <Text type="secondary" style={{ marginBottom: 12, flexShrink: 0, display: 'block' }}>
        {t('excel.pageHint')}
      </Text>

      {checking && checkProgress && (
        <Card size="small" style={{ marginBottom: 12, flexShrink: 0 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Text>
              {i18n.exists(`excel.progress.stage.${checkProgress.stage}`)
                ? t(`excel.progress.stage.${checkProgress.stage}`)
                : t('excel.progress.working')}
              {checkProgress.total > 0
                ? ` — ${checkProgress.current} / ${checkProgress.total}`
                : checkProgress.current > 0
                  ? ` — ${checkProgress.current}`
                  : ''}
              {formatEta(checkProgress.current, checkProgress.total, progressStartedAt)
                ? ` · ${formatEta(checkProgress.current, checkProgress.total, progressStartedAt)}`
                : ''}
            </Text>
            <Progress
              percent={
                checkProgress.total > 0
                  ? Math.min(99, Math.round((checkProgress.current / checkProgress.total) * 100))
                  : checkProgress.current > 0
                    ? 50
                    : 10
              }
              status="active"
              showInfo={checkProgress.total > 0}
            />
            <Button danger icon={<StopOutlined />} onClick={() => void handleCancelCheck()}>
              {t('excel.progress.cancel')}
            </Button>
          </Space>
        </Card>
      )}

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          <Card
            size="small"
            title={t('excel.smart.step1Title')}
            extra={
              <Space>
                {configs.length > 0 && (
                  <Select
                    placeholder={t('excel.config.loadPlaceholder')}
                    style={{ width: 180 }}
                    value={selectedConfigId || undefined}
                    onChange={handleLoadConfig}
                    options={configs.map((c) => ({ value: c.id, label: c.name }))}
                    allowClear
                    onClear={() => selectConfig(null)}
                  />
                )}
                <Button
                  size="small"
                  icon={<SaveOutlined />}
                  onClick={() => {
                    setEditingConfigId(null);
                    setConfigName('');
                    setSaveConfigModalVisible(true);
                  }}
                >
                  {t('excel.config.save')}
                </Button>
              </Space>
            }
          >
            <Space direction="vertical" style={{ width: '100%' }}>
              <Space wrap>
                <Button icon={<FileExcelOutlined />} onClick={() => void handleSelectExcel()}>
                  {t('excel.match.selectExcel')}
                </Button>
                {excelPath ? <Text type="secondary">{excelPath}</Text> : null}
              </Space>

              {excelInfo ? (
                <>
                  <Space wrap>
                    <Text>{t('excel.match.sheetLabel')}</Text>
                    <Select
                      value={sheetIndex}
                      onChange={(v) => void handleSheetChange(v)}
                      style={{ width: 200 }}
                      options={excelInfo.sheets.map((sheet, idx) => ({
                        value: idx,
                        label: sheet,
                      }))}
                    />
                    <Text type="secondary">
                      {t('excel.match.rowCount', { count: excelInfo.rowCount })}
                    </Text>
                  </Space>
                  <Space wrap>
                    <Text>{t('excel.integrity.nameColumnLabel')}</Text>
                    <Select
                      value={nameColumn}
                      onChange={setNameColumn}
                      style={{ width: 300 }}
                      placeholder={t('excel.integrity.nameColumnPlaceholder')}
                      options={excelInfo.columns.map((col) => ({
                        value: col.index,
                        label: `${t('excel.match.columnOption', {
                          letter: col.letter,
                          name: col.name,
                        })}${
                          col.sampleValues[0]
                            ? t('excel.match.columnSample', { sample: col.sampleValues[0] })
                            : ''
                        }`,
                      }))}
                    />
                  </Space>
                  <Space wrap>
                    <Text>{t('excel.integrity.folderMatchModeLabel')}</Text>
                    <Radio.Group
                      value={folderMatchMode}
                      onChange={(e) => setFolderMatchMode(e.target.value)}
                    >
                      <Radio.Button value="contains">{t('excel.match.matchContains')}</Radio.Button>
                      <Radio.Button value="exact">{t('excel.match.matchExact')}</Radio.Button>
                      <Radio.Button value="starts_with">
                        {t('excel.match.matchStartsWith')}
                      </Radio.Button>
                    </Radio.Group>
                  </Space>
                </>
              ) : null}
            </Space>
          </Card>

          <Card size="small" title={t('excel.smart.step2Title')}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Space wrap>
                <Button icon={<FolderOpenOutlined />} onClick={() => void handleSelectFolder()}>
                  {t('excel.match.localFolder')}
                </Button>
                <Button icon={<CloudOutlined />} onClick={() => setRemoteSelectorVisible(true)}>
                  {t('excel.match.remoteFolder')}
                </Button>
                {targetFolder ? (
                  <Tag color={isRemote ? 'blue' : 'default'}>
                    {isRemote ? t('excel.match.remotePrefix') : ''}
                    {targetFolder}
                  </Tag>
                ) : null}
              </Space>
              {isRemote ? (
                <Alert type="info" showIcon message={t('excel.messages.remoteCheckHint')} />
              ) : null}
              {targetFolder ? (
                <div>
                  {scanningTree ? (
                    <Spin tip={t('excel.match.scanning')} />
                  ) : folderTree && folderTree.length > 0 ? (
                    <>
                      <Text type="secondary">
                        {t('excel.match.treeSummary', {
                          folders: treeInfo?.folders ?? 0,
                          files: treeInfo?.files ?? 0,
                        })}
                      </Text>
                      <Tree
                        showIcon
                        treeData={folderTree}
                        style={{
                          marginTop: 8,
                          maxHeight: 320,
                          overflow: 'auto',
                          border: '1px solid #303030',
                          borderRadius: 4,
                          padding: 8,
                        }}
                      />
                    </>
                  ) : null}
                </div>
              ) : null}
            </Space>
          </Card>

          <Card size="small" title={t('excel.smart.step3Title')}>
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              <Space wrap>
                <Text>{t('excel.smart.presetLabel')}</Text>
                <Select
                  value={presetId}
                  style={{ minWidth: 220 }}
                  onChange={(id) => applyPreset(id)}
                  options={PRESET_OPTIONS.map((p) => ({
                    value: p.id,
                    label: t(p.labelKey),
                  }))}
                />
              </Space>
              <Space wrap>
                <Text>{t('excel.smart.scopeLabel')}</Text>
                <Radio.Group
                  value={scope}
                  onChange={(e) => {
                    setPresetId('custom');
                    setScope(e.target.value);
                  }}
                >
                  <Radio.Button value="person_folders">
                    {t('excel.smart.scopePersonFolders')}
                  </Radio.Button>
                  <Radio.Button value="flat_files">{t('excel.smart.scopeFlatFiles')}</Radio.Button>
                  <Radio.Button value="recursive_files">
                    {t('excel.smart.scopeRecursiveFiles')}
                  </Radio.Button>
                </Radio.Group>
              </Space>
              <Text type="secondary">{t('excel.smart.rulesHint')}</Text>
              {rules.map((rule, idx) => (
                <Space key={idx} wrap align="start" style={{ width: '100%' }}>
                  <Tag color={rule.type === 'require' ? 'blue' : 'orange'}>
                    {rule.type === 'require'
                      ? t('excel.smart.ruleRequire')
                      : t('excel.smart.ruleFlag')}
                  </Tag>
                  {rule.type === 'require' ? (
                    <Input
                      style={{ width: 280 }}
                      value={rule.pattern}
                      placeholder="{name}.docx"
                      onChange={(e) =>
                        updateRule(idx, { type: 'require', pattern: e.target.value })
                      }
                    />
                  ) : (
                    <>
                      <Input
                        style={{ width: 140 }}
                        value={rule.needle}
                        placeholder={t('excel.smart.ruleNeedle')}
                        onChange={(e) =>
                          updateRule(idx, {
                            type: 'flag_contains',
                            needle: e.target.value,
                            label: rule.label,
                          })
                        }
                      />
                      <Input
                        style={{ width: 120 }}
                        value={rule.label}
                        placeholder={t('excel.smart.ruleLabel')}
                        onChange={(e) =>
                          updateRule(idx, {
                            type: 'flag_contains',
                            needle: rule.needle,
                            label: e.target.value,
                          })
                        }
                      />
                    </>
                  )}
                  <Button
                    size="small"
                    icon={<ArrowUpOutlined />}
                    onClick={() => moveRule(idx, -1)}
                    disabled={idx === 0}
                  />
                  <Button
                    size="small"
                    icon={<ArrowDownOutlined />}
                    onClick={() => moveRule(idx, 1)}
                    disabled={idx === rules.length - 1}
                  />
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => {
                      setPresetId('custom');
                      setRules((prev) => prev.filter((_, i) => i !== idx));
                    }}
                  >
                    {t('excel.smart.removeRule')}
                  </Button>
                </Space>
              ))}
              <Space>
                <Button
                  icon={<PlusOutlined />}
                  onClick={() => {
                    setPresetId('custom');
                    setRules((prev) => [...prev, { type: 'require', pattern: '{name}.docx' }]);
                  }}
                >
                  {t('excel.smart.addRequire')}
                </Button>
                <Button
                  icon={<PlusOutlined />}
                  onClick={() => {
                    setPresetId('custom');
                    setRules((prev) => [
                      ...prev,
                      { type: 'flag_contains', needle: '缺病例', label: '缺病例' },
                    ]);
                  }}
                >
                  {t('excel.smart.addFlag')}
                </Button>
              </Space>
            </Space>
          </Card>

          <Button
            type="primary"
            size="large"
            icon={<SearchOutlined />}
            onClick={() => void handleRun()}
            loading={checking}
            disabled={checking || !excelPath || nameColumn === null || !targetFolder}
            block
          >
            {t('excel.smart.start')}
          </Button>

          {result ? (
            <Card size="small" title={t('excel.integrity.resultTitle')}>
              <Row gutter={16} style={{ marginBottom: 16 }}>
                <Col span={4}>
                  <Statistic title={t('excel.integrity.statTotalRows')} value={result.totalRows} />
                </Col>
                <Col span={5}>
                  <Statistic
                    title={t('excel.integrity.statComplete')}
                    value={result.completeCount}
                    valueStyle={{ color: '#52c41a' }}
                    prefix={<CheckCircleOutlined />}
                  />
                </Col>
                <Col span={5}>
                  <Statistic
                    title={t('excel.integrity.statMissingFiles')}
                    value={result.incompleteCount}
                    valueStyle={{ color: '#ff4d4f' }}
                    prefix={<CloseCircleOutlined />}
                  />
                </Col>
                <Col span={5}>
                  <Statistic
                    title={t('excel.integrity.statFolderNotFound')}
                    value={result.notFoundCount}
                    valueStyle={{ color: '#faad14' }}
                  />
                </Col>
                <Col span={5}>
                  <Statistic
                    title={t('excel.smart.statFlagged')}
                    value={result.flaggedCount}
                    valueStyle={{ color: '#1677ff' }}
                  />
                </Col>
              </Row>

              {result.outputPath ? (
                <Alert
                  type="success"
                  message={t('excel.integrity.annotatedAlert', { path: result.outputPath })}
                  style={{ marginBottom: 16 }}
                />
              ) : null}

              <Table
                dataSource={result.items.filter((item) => !item.isComplete || item.flags.length > 0)}
                rowKey="rowIndex"
                size="small"
                virtual
                scroll={{ y: 360 }}
                pagination={{ pageSize: 50, showSizeChanger: true }}
                title={() => <Text strong>{t('excel.integrity.incompleteListTitle')}</Text>}
                rowClassName={(record) => (!record.isComplete ? 'row-missing' : '')}
                columns={[
                  {
                    title: t('excel.integrity.colRowIndex'),
                    dataIndex: 'rowIndex',
                    width: 60,
                  },
                  { title: t('excel.integrity.colName'), dataIndex: 'name', width: 120 },
                  {
                    title: t('excel.smart.colBound'),
                    width: 100,
                    render: (_: unknown, record: MaterialCheckItem) =>
                      record.bound ? (
                        <Tag color="success">{t('excel.smart.boundYes')}</Tag>
                      ) : (
                        <Tag color="warning">{t('excel.smart.boundNo')}</Tag>
                      ),
                  },
                  {
                    title: t('excel.smart.colFlags'),
                    width: 120,
                    render: (_: unknown, record: MaterialCheckItem) =>
                      record.flags.length ? (
                        record.flags.map((f) => (
                          <Tag color="orange" key={f}>
                            {f}
                          </Tag>
                        ))
                      ) : (
                        '—'
                      ),
                  },
                  ...rules
                    .filter((r): r is Extract<CheckRule, { type: 'require' }> => r.type === 'require')
                    .map((rule, idx) => ({
                      title: rule.pattern,
                      key: `req_${idx}`,
                      width: 120,
                      ellipsis: true as const,
                      render: (_: unknown, record: MaterialCheckItem) => {
                        const check = requireOutcomes(record)[idx];
                        if (!check?.ok) return <Tag color="error">✗</Tag>;
                        const path = check.foundPath;
                        return path ? (
                          <Tooltip title={path}>
                            <Tag color="success">✓ {path.split(/[/\\]/).pop()}</Tag>
                          </Tooltip>
                        ) : (
                          <Tag color="success">✓</Tag>
                        );
                      },
                    })),
                  {
                    title: t('excel.integrity.colFolderPath'),
                    dataIndex: 'boundPath',
                    ellipsis: true,
                    render: (p: string | null) => p || '—',
                  },
                ]}
              />
            </Card>
          ) : null}
        </Space>
      </div>

      <RemoteFolderSelector
        open={remoteSelectorVisible}
        onClose={() => setRemoteSelectorVisible(false)}
        onSelect={handleRemoteSelect}
      />

      <Modal
        title={editingConfigId ? t('excel.config.modalUpdate') : t('excel.config.modalSave')}
        open={saveConfigModalVisible}
        onOk={handleSaveConfig}
        onCancel={() => {
          setSaveConfigModalVisible(false);
          setConfigName('');
          setEditingConfigId(null);
        }}
        okText={t('excel.config.okSave')}
        cancelText={t('excel.config.cancel')}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>
            <Text strong>{t('excel.config.labelName')}</Text>
            <Input
              placeholder={t('excel.config.namePlaceholder')}
              value={configName}
              onChange={(e) => setConfigName(e.target.value)}
              style={{ marginTop: 8 }}
            />
          </div>
          <Alert
            type="info"
            message={
              <>
                <div>
                  <strong>{t('excel.config.previewTitle')}</strong>
                </div>
                <div>
                  {t('excel.config.previewTargetFolder', {
                    path: targetFolder || t('excel.config.previewNotSelected'),
                  })}
                </div>
                <div>{t('excel.config.previewTemplates', { count: rules.length })}</div>
              </>
            }
          />
          {selectedConfigId ? (
            <Popconfirm
              title={t('excel.config.deleteConfirm')}
              onConfirm={() => {
                deleteConfig(selectedConfigId);
                selectConfig(null);
                message.success(t('excel.config.deleted'));
              }}
            >
              <Button danger icon={<DeleteOutlined />}>
                {t('excel.config.delete')}
              </Button>
            </Popconfirm>
          ) : null}
          {configs.length > 0 ? (
            <Button
              icon={<SettingOutlined />}
              onClick={() => {
                const cfg = configs.find((c) => c.id === selectedConfigId);
                if (cfg) {
                  setEditingConfigId(cfg.id);
                  setConfigName(cfg.name);
                }
              }}
              disabled={!selectedConfigId}
            >
              {t('excel.config.editSelected')}
            </Button>
          ) : null}
        </Space>
      </Modal>

      <style>{`
        .row-missing {
          background-color: #fff2f0 !important;
        }
        .row-missing:hover > td {
          background-color: #ffccc7 !important;
        }
      `}</style>
    </div>
  );
};

export default ExcelCheck;
