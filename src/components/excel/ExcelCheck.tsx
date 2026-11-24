import React, { useEffect, useRef, useState } from 'react';
import {
  Card,
  Space,
  Button,
  Select,
  Input,
  Table,
  Typography,
  Tabs,
  Tag,
  message,
  Progress,
  Divider,
  Radio,
  Tooltip,
  Empty,
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
} from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { mapBackendError } from '../../utils/backendError';
import { RemoteFolderSelector } from '../search/RemoteFolderSelector';
import { useCheckConfigStore } from '../../stores';

const { Title, Text } = Typography;
const { TextArea } = Input;

// 类型定义
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

interface MatchResultItem {
  rowIndex: number;
  value: string;
  matched: boolean;
  matchedFile: string | null;
}

interface ExcelMatchResult {
  totalRows: number;
  matchedCount: number;
  missingCount: number;
  items: MatchResultItem[];
  outputPath: string | null;
  truncated?: boolean;
  cancelled?: boolean;
}

interface IntegrityCheckItem {
  template: string;
  expectedName: string;
  exists: boolean;
  foundPath: string | null;
}

interface FolderIntegrityResult {
  folderPath: string;
  folderName: string;
  extractedName: string;
  isComplete: boolean;
  checkItems: IntegrityCheckItem[];
}

interface BatchIntegrityResult {
  totalFolders: number;
  completeCount: number;
  incompleteCount: number;
  results: FolderIntegrityResult[];
  outputPath: string | null;
  truncated?: boolean;
  cancelled?: boolean;
}

// 基于 Excel 的完整性检查结果
interface TemplateCheckResult {
  template: string;
  expectedName: string;
  exists: boolean;
}

interface ExcelIntegrityItem {
  rowIndex: number;
  name: string;
  folderFound: boolean;
  folderPath: string | null;
  isComplete: boolean;
  checkResults: TemplateCheckResult[];
}

interface ExcelIntegrityResult {
  totalRows: number;
  completeCount: number;
  incompleteCount: number;
  notFoundCount: number;
  items: ExcelIntegrityItem[];
  outputPath: string | null;
  truncated?: boolean;
  cancelled?: boolean;
}

// 文件树节点
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

// 转换为 Ant Design Tree 数据格式
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

export const ExcelCheck: React.FC = () => {
  const { t } = useTranslation();

  // Excel 比对状态
  const [excelPath, setExcelPath] = useState<string>('');
  const [excelInfo, setExcelInfo] = useState<ExcelFileInfo | null>(null);
  const [selectedSheet, setSelectedSheet] = useState<number>(0);
  const [selectedColumn, setSelectedColumn] = useState<number | null>(null);
  const [targetFolder, setTargetFolder] = useState<string>('');
  const [isRemote, setIsRemote] = useState(false);
  const [matchMode, setMatchMode] = useState<string>('contains');
  const [markColor, setMarkColor] = useState<string>('red');
  const [matchResult, setMatchResult] = useState<ExcelMatchResult | null>(null);
  const [matching, setMatching] = useState(false);
  const [checkProgress, setCheckProgress] = useState<ExcelCheckProgress | null>(null);
  const [progressStartedAt, setProgressStartedAt] = useState<number | null>(null);
  const activeJobIdRef = useRef<number | null>(null);

  // 完整性检查状态
  const [integrityFolder, setIntegrityFolder] = useState<string>('');
  const [integrityIsRemote, setIntegrityIsRemote] = useState(false);
  const [templates, setTemplates] = useState<string[]>(() =>
    i18n.t('excel.defaults.sampleTemplates').split('\n').filter(Boolean)
  );
  const [namePattern, setNamePattern] = useState<string>('auto');
  const [integrityResult, setIntegrityResult] = useState<BatchIntegrityResult | null>(null);
  const [checking, setChecking] = useState(false);
  
  // 基于 Excel 的完整性检查状态
  const [integritySource, setIntegritySource] = useState<'folder' | 'excel'>('excel');
  const [integrityExcelPath, setIntegrityExcelPath] = useState<string>('');
  const [integrityExcelInfo, setIntegrityExcelInfo] = useState<ExcelFileInfo | null>(null);
  const [integritySheet, setIntegritySheet] = useState<number>(0);
  const [integrityNameColumn, setIntegrityNameColumn] = useState<number | null>(null);
  const [integrityFolderMatchMode, setIntegrityFolderMatchMode] = useState<string>('contains');
  const [excelIntegrityResult, setExcelIntegrityResult] = useState<ExcelIntegrityResult | null>(null);

  // 远程选择器状态
  const [remoteSelectorVisible, setRemoteSelectorVisible] = useState(false);
  const [remoteSelectorTarget, setRemoteSelectorTarget] = useState<'match' | 'integrity'>('match');

  // 文件树状态
  const [matchFolderTree, setMatchFolderTree] = useState<TreeDataNode[] | null>(null);
  const [matchTreeInfo, setMatchTreeInfo] = useState<{ files: number; folders: number } | null>(null);
  const [integrityFolderTree, setIntegrityFolderTree] = useState<TreeDataNode[] | null>(null);
  const [integrityTreeInfo, setIntegrityTreeInfo] = useState<{ files: number; folders: number } | null>(null);
  const [scanningTree, setScanningTree] = useState(false);

  // 配置管理
  const { configs, addConfig, updateConfig, deleteConfig, selectConfig, selectedConfigId } = useCheckConfigStore();
  const [saveConfigModalVisible, setSaveConfigModalVisible] = useState(false);
  const [configName, setConfigName] = useState('');
  const [editingConfigId, setEditingConfigId] = useState<string | null>(null);

  // 加载配置
  const handleLoadConfig = (configId: string) => {
    const config = configs.find(c => c.id === configId);
    if (config) {
      setIntegrityFolder(config.targetFolder);
      setTemplates(config.templates);
      setNamePattern(config.namePattern);
      selectConfig(configId);
      // 预览只扫一层；真正检查时后端会全树递归
      if (config.targetFolder) {
        scanFolderTree(config.targetFolder, 'integrity');
      }
      message.success(t('excel.config.loaded', { name: config.name }));
    }
  };

  // 保存配置
  const handleSaveConfig = () => {
    if (!configName.trim()) {
      message.warning(t('excel.config.nameRequired'));
      return;
    }

    if (editingConfigId) {
      // 更新现有配置
      updateConfig(editingConfigId, {
        name: configName,
        targetFolder: integrityFolder,
        templates,
        namePattern,
      });
      message.success(t('excel.config.updated'));
    } else {
      // 新建配置
      const id = addConfig({
        name: configName,
        targetFolder: integrityFolder,
        templates,
        namePattern,
      });
      selectConfig(id);
      message.success(t('excel.config.saved'));
    }

    setSaveConfigModalVisible(false);
    setConfigName('');
    setEditingConfigId(null);
  };

  // 打开保存配置弹窗
  const openSaveConfigModal = (isEdit: boolean = false) => {
    if (isEdit && selectedConfigId) {
      const config = configs.find(c => c.id === selectedConfigId);
      if (config) {
        setConfigName(config.name);
        setEditingConfigId(selectedConfigId);
      }
    } else {
      setConfigName('');
      setEditingConfigId(null);
    }
    setSaveConfigModalVisible(true);
  };

  // 删除配置
  const handleDeleteConfig = (configId: string) => {
    deleteConfig(configId);
    message.success(t('excel.config.deleted'));
  };


  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<ExcelCheckProgress>('excel-check-progress', (event) => {
      const payload = event.payload;
      if (activeJobIdRef.current != null && payload.jobId !== activeJobIdRef.current) {
        return;
      }
      setCheckProgress(payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const formatEta = (current: number, total: number, startedAt: number | null) => {
    if (!startedAt || total <= 0 || current <= 0) return null;
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = current / elapsed;
    if (rate <= 0) return null;
    const remain = Math.max(0, Math.round((total - current) / rate));
    if (remain < 60) return t('excel.progress.etaSeconds', { seconds: remain });
    return t('excel.progress.etaMinutes', { minutes: Math.ceil(remain / 60) });
  };

  const beginCheckJob = async () => {
    const jobId = await invoke<number>('prepare_excel_check');
    activeJobIdRef.current = jobId;
    setCheckProgress({ jobId, stage: 'preparing', current: 0, total: 0, message: '' });
    setProgressStartedAt(Date.now());
    return jobId;
  };

  const handleCancelCheck = async () => {
    const jobId = activeJobIdRef.current;
    try {
      await invoke('cancel_excel_check', { jobId });
      message.info(t('excel.messages.cancelRequested'));
    } catch (error) {
      message.error(t('excel.messages.cancelFailed', { error: mapBackendError(error) }));
    }
  };

  const finishCheckJob = () => {
    activeJobIdRef.current = null;
    setCheckProgress(null);
    setProgressStartedAt(null);
  };

  // 将后端文件树转换为 Ant Design Tree 格式
  const convertToTreeData = (node: FileTreeNode): TreeDataNode => {
    return {
      key: node.path,
      title: node.name,
      icon: node.isDir ? <FolderOutlined /> : <FileOutlined />,
      isLeaf: !node.isDir,
      children: node.children?.map(convertToTreeData),
    };
  };

  // UI 预览：只扫第一层，不限制子文件夹数量；智能检查另走全树递归，无需点开每个节点
  const scanFolderTree = async (folderPath: string, target: 'match' | 'integrity') => {
    setScanningTree(true);
    try {
      const result = await invoke<FolderTreeResult>('scan_folder_tree', {
        folderPath,
        maxDepth: 1,
      });

      const treeData = result.root.children?.map(convertToTreeData) || [];
      const info = { files: result.totalFiles, folders: result.totalFolders };

      if (target === 'match') {
        setMatchFolderTree(treeData);
        setMatchTreeInfo(info);
      } else {
        setIntegrityFolderTree(treeData);
        setIntegrityTreeInfo(info);
      }

      if (result.truncated) {
        message.warning(t('excel.messages.truncatedWarning'));
      }
    } catch (error) {
      console.error('scan folder tree failed:', error);
      message.error(t('excel.messages.scanTreeFailed', { error: mapBackendError(error) }));
    } finally {
      setScanningTree(false);
    }
  };

  // 选择 Excel 文件
  const handleSelectExcel = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: t('excel.filterExcel'), extensions: ['xlsx', 'xls'] }],
      });

      if (selected) {
        setExcelPath(selected as string);
        setExcelInfo(null);
        setMatchResult(null);

        // 读取 Excel 信息
        const info = await invoke<ExcelFileInfo>('read_excel_info', {
          filePath: selected,
          sheetIndex: 0,
        });

        setExcelInfo(info);
        setSelectedSheet(0);
        setSelectedColumn(null);
      }
    } catch (error) {
      message.error(t('excel.messages.openFileFailed', { error: mapBackendError(error) }));
    }
  };

  // 切换工作表
  const handleSheetChange = async (sheetIndex: number) => {
    if (!excelPath) return;

    try {
      const info = await invoke<ExcelFileInfo>('read_excel_info', {
        filePath: excelPath,
        sheetIndex,
      });

      setExcelInfo(info);
      setSelectedSheet(sheetIndex);
      setSelectedColumn(null);
    } catch (error) {
      message.error(t('excel.messages.readSheetFailed', { error: mapBackendError(error) }));
    }
  };

  // 选择本地文件夹
  const handleSelectFolder = async (target: 'match' | 'integrity') => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });

      if (selected) {
        const folderPath = selected as string;
        if (target === 'match') {
          setTargetFolder(folderPath);
          setIsRemote(false);
          setMatchFolderTree(null);
          setMatchTreeInfo(null);
        } else {
          setIntegrityFolder(folderPath);
          setIntegrityIsRemote(false);
          setIntegrityFolderTree(null);
          setIntegrityTreeInfo(null);
        }
        // 自动扫描文件树
        scanFolderTree(folderPath, target);
      }
    } catch (error) {
      message.error(t('excel.messages.selectFolderFailed', { error: mapBackendError(error) }));
    }
  };

  // 打开远程选择器
  const handleSelectRemote = (target: 'match' | 'integrity') => {
    setRemoteSelectorTarget(target);
    setRemoteSelectorVisible(true);
  };

  // 远程文件夹选择回调
  const handleRemoteSelect = (path: string) => {
    if (remoteSelectorTarget === 'match') {
      setTargetFolder(path);
      setIsRemote(true);
      setMatchFolderTree(null);
      setMatchTreeInfo(null);
      scanFolderTree(path, 'match');
    } else {
      setIntegrityFolder(path);
      setIntegrityIsRemote(true);
      setIntegrityFolderTree(null);
      setIntegrityTreeInfo(null);
      scanFolderTree(path, 'integrity');
    }
    setRemoteSelectorVisible(false);
  };

  // 执行 Excel 比对
  const handleMatch = async () => {
    if (!excelPath || selectedColumn === null || !targetFolder) {
      message.warning(t('excel.messages.matchPrerequisite'));
      return;
    }
    setMatching(true);
    try {
      const outputPath = await save({
        defaultPath: excelPath.replace(/\.xlsx?$/i, t('excel.defaults.matchOutputSuffix')),
        filters: [{ name: t('excel.filterExcel'), extensions: ['xlsx'] }],
      });

      const jobId = await beginCheckJob();
      const result = await invoke<ExcelMatchResult>('match_excel_with_folder', {
        excelPath,
        sheetIndex: selectedSheet,
        columnIndex: selectedColumn,
        folderPath: targetFolder,
        matchMode,
        markColor,
        outputPath: outputPath || null,
        jobId,
      });

      setMatchResult(result);

      if (result.cancelled) {
        message.warning(t('excel.messages.checkCancelled'));
      } else if (result.truncated) {
        message.warning(t('excel.messages.truncatedWarning'));
      }
      if (result.outputPath) {
        message.success(t('excel.messages.matchDoneSaved', { path: result.outputPath }));
      } else if (!result.cancelled) {
        message.success(t('excel.messages.matchDone'));
      }
    } catch (error) {
      message.error(t('excel.messages.matchFailed', { error: mapBackendError(error) }));
    } finally {
      setMatching(false);
      finishCheckJob();
    }
  };

  // 执行完整性检查
  const handleIntegrityCheck = async () => {
    if (!integrityFolder || templates.length === 0) {
      message.warning(t('excel.messages.integrityPrerequisiteTemplates'));
      return;
    }
    setChecking(true);
    try {
      const outputPath = await save({
        defaultPath: t('excel.defaults.integrityReportFileName'),
        filters: [{ name: t('excel.filterExcel'), extensions: ['xlsx'] }],
      });

      const jobId = await beginCheckJob();
      const result = await invoke<BatchIntegrityResult>('check_folder_integrity', {
        targetFolder: integrityFolder,
        templates,
        namePattern,
        outputPath: outputPath || null,
        jobId,
      });

      setIntegrityResult(result);

      if (result.cancelled) {
        message.warning(t('excel.messages.checkCancelled'));
      } else if (result.truncated) {
        message.warning(t('excel.messages.truncatedWarning'));
      }
      if (result.outputPath) {
        message.success(t('excel.messages.checkDoneSavedReport', { path: result.outputPath }));
      } else if (!result.cancelled) {
        message.success(t('excel.messages.checkDone'));
      }
    } catch (error) {
      message.error(t('excel.messages.checkFailed', { error: mapBackendError(error) }));
    } finally {
      setChecking(false);
      finishCheckJob();
    }
  };

  // 选择完整性检查用的 Excel 文件
  const handleSelectIntegrityExcel = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: t('excel.filterExcel'), extensions: ['xlsx', 'xls'] }],
      });

      if (selected) {
        setIntegrityExcelPath(selected as string);
        setIntegrityExcelInfo(null);
        setExcelIntegrityResult(null);

        // 读取 Excel 信息
        const info = await invoke<ExcelFileInfo>('read_excel_info', {
          filePath: selected,
          sheetIndex: 0,
        });

        setIntegrityExcelInfo(info);
        setIntegritySheet(0);
        setIntegrityNameColumn(null);
      }
    } catch (error) {
      message.error(t('excel.messages.openFileFailed', { error: mapBackendError(error) }));
    }
  };

  // 切换完整性检查的工作表
  const handleIntegritySheetChange = async (sheetIndex: number) => {
    if (!integrityExcelPath) return;

    try {
      const info = await invoke<ExcelFileInfo>('read_excel_info', {
        filePath: integrityExcelPath,
        sheetIndex,
      });

      setIntegrityExcelInfo(info);
      setIntegritySheet(sheetIndex);
      setIntegrityNameColumn(null);
    } catch (error) {
      message.error(t('excel.messages.readSheetFailed', { error: mapBackendError(error) }));
    }
  };

  // 执行基于 Excel 的完整性检查
  const handleExcelIntegrityCheck = async () => {
    if (!integrityExcelPath || integrityNameColumn === null || !integrityFolder || templates.length === 0) {
      message.warning(t('excel.messages.integrityPrerequisiteExcel'));
      return;
    }
    setChecking(true);
    try {
      const outputPath = await save({
        defaultPath: integrityExcelPath.replace(/\.xlsx?$/i, t('excel.defaults.integrityOutputSuffix')),
        filters: [{ name: t('excel.filterExcel'), extensions: ['xlsx'] }],
      });

      const jobId = await beginCheckJob();
      const result = await invoke<ExcelIntegrityResult>('check_integrity_with_excel', {
        excelPath: integrityExcelPath,
        sheetIndex: integritySheet,
        nameColumnIndex: integrityNameColumn,
        targetFolder: integrityFolder,
        templates,
        folderMatchMode: integrityFolderMatchMode,
        outputPath: outputPath || null,
        jobId,
      });

      setExcelIntegrityResult(result);

      if (result.cancelled) {
        message.warning(t('excel.messages.checkCancelled'));
      } else if (result.truncated) {
        message.warning(t('excel.messages.truncatedWarning'));
      }
      if (result.outputPath) {
        message.success(t('excel.messages.checkDoneAnnotated', { path: result.outputPath }));
      } else if (!result.cancelled) {
        message.success(t('excel.messages.checkDone'));
      }
    } catch (error) {
      message.error(t('excel.messages.checkFailed', { error: mapBackendError(error) }));
    } finally {
      setChecking(false);
      finishCheckJob();
    }
  };

  // 匹配结果表格列
  const matchColumns = [
    {
      title: t('excel.match.colRowIndex'),
      dataIndex: 'rowIndex',
      key: 'rowIndex',
      width: 80,
    },
    {
      title: t('excel.match.colValue'),
      dataIndex: 'value',
      key: 'value',
      ellipsis: true,
    },
    {
      title: t('excel.match.colStatus'),
      dataIndex: 'matched',
      key: 'matched',
      width: 100,
      render: (matched: boolean) =>
        matched ? (
          <Tag color="success" icon={<CheckCircleOutlined />}>
            {t('excel.match.statusMatched')}
          </Tag>
        ) : (
          <Tag color="error" icon={<CloseCircleOutlined />}>
            {t('excel.match.statusMissing')}
          </Tag>
        ),
    },
    {
      title: t('excel.match.colMatchedFiles'),
      dataIndex: 'matchedFile',
      key: 'matchedFile',
      ellipsis: true,
      render: (file: string | null) => file || '-',
    },
  ];

  // 完整性检查结果表格列
  const integrityColumns = [
    {
      title: t('excel.integrity.colFolder'),
      dataIndex: 'folderName',
      key: 'folderName',
      ellipsis: true,
    },
    {
      title: t('excel.integrity.colExtractedName'),
      dataIndex: 'extractedName',
      key: 'extractedName',
      width: 120,
    },
    ...templates.map((template, idx) => ({
      title: template,
      key: `template_${idx}`,
      width: 100,
      render: (_: unknown, record: FolderIntegrityResult) => {
        const item = record.checkItems[idx];
        return item?.exists ? (
          <Tag color="success">✓</Tag>
        ) : (
          <Tag color="error">✗</Tag>
        );
      },
    })),
    {
      title: t('excel.integrity.colStatus'),
      dataIndex: 'isComplete',
      key: 'isComplete',
      width: 80,
      render: (isComplete: boolean) =>
        isComplete ? (
          <Tag color="success">{t('excel.integrity.statusComplete')}</Tag>
        ) : (
          <Tag color="error">{t('excel.integrity.statusMissing')}</Tag>
        ),
    },
  ];

  // Tab 1: Excel 比对
  const renderMatchTab = () => (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      {/* Excel 文件选择 */}
      <Card size="small" title={t('excel.match.step1Title')}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space>
            <Button icon={<FileExcelOutlined />} onClick={handleSelectExcel}>
              {t('excel.match.selectExcel')}
            </Button>
            {excelPath && <Text type="secondary">{excelPath}</Text>}
          </Space>

          {excelInfo && (
            <>
              <Space>
                <Text>{t('excel.match.sheetLabel')}</Text>
                <Select
                  value={selectedSheet}
                  onChange={handleSheetChange}
                  style={{ width: 200 }}
                >
                  {excelInfo.sheets.map((sheet, idx) => (
                    <Select.Option key={idx} value={idx}>
                      {sheet}
                    </Select.Option>
                  ))}
                </Select>
                <Text type="secondary">{t('excel.match.rowCount', { count: excelInfo.rowCount })}</Text>
              </Space>

              <Space>
                <Text>{t('excel.match.matchColumnLabel')}</Text>
                <Select
                  value={selectedColumn}
                  onChange={setSelectedColumn}
                  style={{ width: 300 }}
                  placeholder={t('excel.match.matchColumnPlaceholder')}
                >
                  {excelInfo.columns.map((col) => (
                    <Select.Option key={col.index} value={col.index}>
                      {t('excel.match.columnOption', { letter: col.letter, name: col.name })}
                      {col.sampleValues.length > 0 && (
                        <Text type="secondary">{t('excel.match.columnSample', { sample: col.sampleValues[0] })}</Text>
                      )}
                    </Select.Option>
                  ))}
                </Select>
              </Space>
            </>
          )}
        </Space>
      </Card>

      {/* 目标文件夹选择 */}
      <Card size="small" title={t('excel.match.step2Title')}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space>
            <Button icon={<FolderOpenOutlined />} onClick={() => handleSelectFolder('match')}>
              {t('excel.match.localFolder')}
            </Button>
            <Button icon={<CloudOutlined />} onClick={() => handleSelectRemote('match')}>
              {t('excel.match.remoteFolder')}
            </Button>
            {targetFolder && (
              <Tag color={isRemote ? 'blue' : 'default'}>
                {isRemote ? t('excel.match.remotePrefix') : ''}{targetFolder}
              </Tag>
            )}
          </Space>

          {/* 文件树预览 */}
          {targetFolder && (
            <div style={{ marginTop: 8 }}>
              {scanningTree ? (
                <Spin tip={t('excel.match.scanning')} />
              ) : matchFolderTree && matchFolderTree.length > 0 ? (
                <>
                  <div style={{ marginBottom: 8 }}>
                    <Text type="secondary">
                      {t('excel.match.treeSummary', {
                        folders: matchTreeInfo?.folders ?? 0,
                        files: matchTreeInfo?.files ?? 0,
                      })}
                    </Text>
                    <div>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {t('excel.messages.treePreviewHint')}
                      </Text>
                    </div>
                  </div>
                  <Tree
                    showIcon
                    defaultExpandedKeys={[]}
                    treeData={matchFolderTree}
                    style={{ 
                      maxHeight: 200, 
                      overflow: 'auto',
                      border: '1px solid #303030',
                      borderRadius: 4,
                      padding: 8,
                    }}
                  />
                </>
              ) : null}
            </div>
          )}
        </Space>
      </Card>

      {/* 匹配选项 */}
      <Card size="small" title={t('excel.match.step3Title')}>
        <Space size="large">
          <Space>
            <Text>{t('excel.match.matchModeLabel')}</Text>
            <Radio.Group value={matchMode} onChange={(e) => setMatchMode(e.target.value)}>
              <Radio.Button value="exact">{t('excel.match.matchExact')}</Radio.Button>
              <Radio.Button value="contains">{t('excel.match.matchContains')}</Radio.Button>
              <Radio.Button value="starts_with">{t('excel.match.matchStartsWith')}</Radio.Button>
            </Radio.Group>
          </Space>

          <Space>
            <Text>{t('excel.match.highlightColorLabel')}</Text>
            <Radio.Group value={markColor} onChange={(e) => setMarkColor(e.target.value)}>
              <Radio.Button value="red" style={{ backgroundColor: markColor === 'red' ? '#ff6b6b' : undefined }}>
                {t('excel.match.colorRed')}
              </Radio.Button>
              <Radio.Button value="yellow" style={{ backgroundColor: markColor === 'yellow' ? '#ffe66d' : undefined }}>
                {t('excel.match.colorYellow')}
              </Radio.Button>
              <Radio.Button value="green" style={{ backgroundColor: markColor === 'green' ? '#6bcb77' : undefined }}>
                {t('excel.match.colorGreen')}
              </Radio.Button>
            </Radio.Group>
          </Space>
        </Space>
      </Card>

      {isRemote && (
        <Alert type="info" showIcon message={t('excel.messages.remoteCheckHint')} />
      )}

      {/* 执行按钮 */}
      <Button
        type="primary"
        size="large"
        icon={<SearchOutlined />}
        onClick={handleMatch}
        loading={matching}
        disabled={!excelPath || selectedColumn === null || !targetFolder || matching || checking}
        block
      >
        {t('excel.match.startMatchExport')}
      </Button>

      {/* 匹配结果 */}
      {matchResult && (
        <Card size="small" title={t('excel.match.resultTitle')}>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={8}>
              <Statistic title={t('excel.match.statTotalRows')} value={matchResult.totalRows} />
            </Col>
            <Col span={8}>
              <Statistic
                title={t('excel.match.statMatched')}
                value={matchResult.matchedCount}
                valueStyle={{ color: '#52c41a' }}
                prefix={<CheckCircleOutlined />}
              />
            </Col>
            <Col span={8}>
              <Statistic
                title={t('excel.match.statMissing')}
                value={matchResult.missingCount}
                valueStyle={{ color: '#ff4d4f' }}
                prefix={<CloseCircleOutlined />}
              />
            </Col>
          </Row>

          {matchResult.outputPath && (
            <Alert
              type="success"
              message={t('excel.match.savedAlert', { path: matchResult.outputPath })}
              style={{ marginBottom: 16 }}
            />
          )}

          <Table
            dataSource={matchResult.items.filter((item) => !item.matched)}
            columns={matchColumns}
            rowKey="rowIndex"
            size="small"
            virtual
                    scroll={{ y: 360 }}
                    pagination={{ pageSize: 50, showSizeChanger: true }}
            title={() => <Text strong>{t('excel.match.missingListTitle')}</Text>}
          />
        </Card>
      )}
    </Space>
  );

  // Tab 2: 完整性检查
  const renderIntegrityTab = () => (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      {/* 名单来源选择 */}
      <Card size="small" title={t('excel.integrity.step1Title')}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Radio.Group 
            value={integritySource} 
            onChange={(e) => setIntegritySource(e.target.value)}
            buttonStyle="solid"
          >
            <Radio.Button value="excel">
              <FileExcelOutlined /> {t('excel.integrity.sourceExcel')}
            </Radio.Button>
            <Radio.Button value="folder">
              <FolderOpenOutlined /> {t('excel.integrity.sourceFolder')}
            </Radio.Button>
          </Radio.Group>
  
          {integritySource === 'excel' ? (
            <>
              <Space>
                <Button icon={<FileExcelOutlined />} onClick={handleSelectIntegrityExcel}>
                  {t('excel.match.selectExcel')}
                </Button>
                {integrityExcelPath && <Text type="secondary">{integrityExcelPath}</Text>}
              </Space>
  
              {integrityExcelInfo && (
                <>
                  <Space>
                    <Text>{t('excel.match.sheetLabel')}</Text>
                    <Select
                      value={integritySheet}
                      onChange={handleIntegritySheetChange}
                      style={{ width: 200 }}
                    >
                      {integrityExcelInfo.sheets.map((sheet, idx) => (
                        <Select.Option key={idx} value={idx}>
                          {sheet}
                        </Select.Option>
                      ))}
                    </Select>
                    <Text type="secondary">{t('excel.integrity.rowCount', { count: integrityExcelInfo.rowCount })}</Text>
                  </Space>
  
                  <Space>
                    <Text>{t('excel.integrity.nameColumnLabel')}</Text>
                    <Select
                      value={integrityNameColumn}
                      onChange={setIntegrityNameColumn}
                      style={{ width: 300 }}
                      placeholder={t('excel.integrity.nameColumnPlaceholder')}
                    >
                      {integrityExcelInfo.columns.map((col) => (
                        <Select.Option key={col.index} value={col.index}>
                          {t('excel.match.columnOption', { letter: col.letter, name: col.name })}
                          {col.sampleValues.length > 0 && (
                            <Text type="secondary">{t('excel.match.columnSample', { sample: col.sampleValues[0] })}</Text>
                          )}
                        </Select.Option>
                      ))}
                    </Select>
                  </Space>
  
                  <Space>
                    <Text>{t('excel.integrity.folderMatchModeLabel')}</Text>
                    <Radio.Group value={integrityFolderMatchMode} onChange={(e) => setIntegrityFolderMatchMode(e.target.value)}>
                      <Radio.Button value="contains">{t('excel.match.matchContains')}</Radio.Button>
                      <Radio.Button value="exact">{t('excel.match.matchExact')}</Radio.Button>
                      <Radio.Button value="starts_with">{t('excel.match.matchStartsWith')}</Radio.Button>
                    </Radio.Group>
                  </Space>
                </>
              )}
            </>
          ) : (
            <Alert
              type="info"
              message={t('excel.integrity.scanModeAlert')}
            />
          )}
        </Space>
      </Card>
  
      {/* 目标文件夹选择 */}
      <Card size="small" title={t('excel.integrity.step2Title')}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space>
            <Button icon={<FolderOpenOutlined />} onClick={() => handleSelectFolder('integrity')}>
              {t('excel.match.localFolder')}
            </Button>
            <Button icon={<CloudOutlined />} onClick={() => handleSelectRemote('integrity')}>
              {t('excel.match.remoteFolder')}
            </Button>
            {integrityFolder && (
              <Tag color={integrityIsRemote ? 'blue' : 'default'}>
                {integrityIsRemote ? t('excel.integrity.remotePrefix') : ''}{integrityFolder}
              </Tag>
            )}
          </Space>

          {integrityIsRemote && (
            <Alert type="info" showIcon message={t('excel.messages.remoteCheckHint')} />
          )}
  
          {/* 文件树预览 */}
          {integrityFolder && (
            <div style={{ marginTop: 8 }}>
              {scanningTree ? (
                <Spin tip={t('excel.match.scanning')} />
              ) : integrityFolderTree && integrityFolderTree.length > 0 ? (
                <>
                  <div style={{ marginBottom: 8 }}>
                    <Text type="secondary">
                      {t('excel.integrity.treeSummary', {
                        folders: integrityTreeInfo?.folders ?? 0,
                        files: integrityTreeInfo?.files ?? 0,
                      })}
                    </Text>
                    <div>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {t('excel.messages.treePreviewHint')}
                      </Text>
                    </div>
                  </div>
                  <Tree
                    showIcon
                    defaultExpandedKeys={[]}
                    treeData={integrityFolderTree}
                    style={{ 
                      maxHeight: 200, 
                      overflow: 'auto',
                      border: '1px solid #303030',
                      borderRadius: 4,
                      padding: 8,
                    }}
                  />
                </>
              ) : null}
            </div>
          )}
        </Space>
      </Card>
  
      {/* 必需文件模板 */}
      <Card size="small" title={t('excel.integrity.step3Title')}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert
            type="info"
            message={t('excel.integrity.templateHint')}
            style={{ marginBottom: 8 }}
          />
  
          <TextArea
            placeholder={t('excel.integrity.templatePlaceholder')}
            value={templates.join('\n')}
            onChange={(e) => {
              const lines = e.target.value.split('\n').filter(line => line.trim());
              setTemplates(lines);
            }}
            rows={4}
            style={{ width: '100%', fontFamily: 'monospace' }}
          />
  
          <Text type="secondary">{t('excel.integrity.templateCount', { count: templates.length })}</Text>
        </Space>
      </Card>
  
      {/* 姓名提取规则 - 仅扫描模式显示 */}
      {integritySource === 'folder' && (
        <Card size="small" title={t('excel.integrity.step4Title')}>
          <Space>
            <Text>{t('excel.integrity.nameExtractLabel')}</Text>
            <Radio.Group value={namePattern} onChange={(e) => setNamePattern(e.target.value)}>
              <Radio.Button value="auto">{t('excel.integrity.nameExtractAuto')}</Radio.Button>
              <Radio.Button value="">{t('excel.integrity.nameExtractFull')}</Radio.Button>
            </Radio.Group>
          </Space>
          <div style={{ marginTop: 8 }}>
            <Text type="secondary">
              {t('excel.integrity.nameExtractExample')}
            </Text>
          </div>
        </Card>
      )}
  
      {/* 执行按钮 */}
      <Button
        type="primary"
        size="large"
        icon={<SearchOutlined />}
        onClick={integritySource === 'excel' ? handleExcelIntegrityCheck : handleIntegrityCheck}
        loading={checking}
        disabled={
          matching ||
          checking ||
          (integritySource === 'excel'
            ? (!integrityExcelPath || integrityNameColumn === null || !integrityFolder || templates.length === 0)
            : (!integrityFolder || templates.length === 0))
        }
        block
      >
        {integritySource === 'excel' ? t('excel.integrity.startCheckAnnotate') : t('excel.integrity.startCheckExport')}
      </Button>
  
      {/* 基于 Excel 的检查结果 */}
      {integritySource === 'excel' && excelIntegrityResult && (
        <Card size="small" title={t('excel.integrity.resultTitle')}>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={6}>
              <Statistic title={t('excel.integrity.statTotalRows')} value={excelIntegrityResult.totalRows} />
            </Col>
            <Col span={6}>
              <Statistic
                title={t('excel.integrity.statComplete')}
                value={excelIntegrityResult.completeCount}
                valueStyle={{ color: '#52c41a' }}
                prefix={<CheckCircleOutlined />}
              />
            </Col>
            <Col span={6}>
              <Statistic
                title={t('excel.integrity.statMissingFiles')}
                value={excelIntegrityResult.incompleteCount}
                valueStyle={{ color: '#ff4d4f' }}
                prefix={<CloseCircleOutlined />}
              />
            </Col>
            <Col span={6}>
              <Statistic
                title={t('excel.integrity.statFolderNotFound')}
                value={excelIntegrityResult.notFoundCount}
                valueStyle={{ color: '#faad14' }}
              />
            </Col>
          </Row>
  
          {excelIntegrityResult.outputPath && (
            <Alert
              type="success"
              message={t('excel.integrity.annotatedAlert', { path: excelIntegrityResult.outputPath })}
              style={{ marginBottom: 16 }}
            />
          )}
  
          <Table
            dataSource={excelIntegrityResult.items.filter(item => !item.isComplete)}
            columns={[
              { title: t('excel.integrity.colRowIndex'), dataIndex: 'rowIndex', key: 'rowIndex', width: 60 },
              { title: t('excel.integrity.colName'), dataIndex: 'name', key: 'name', width: 100 },
              {
                title: t('excel.integrity.colFolder'),
                key: 'folder',
                width: 120,
                render: (_: unknown, record: ExcelIntegrityItem) => 
                  record.folderFound ? (
                    <Tag color="success">{t('excel.integrity.folderFound')}</Tag>
                  ) : (
                    <Tag color="warning">{t('excel.integrity.folderNotFound')}</Tag>
                  ),
              },
              ...templates.map((template, idx) => ({
                title: template,
                key: `template_${idx}`,
                width: 80,
                render: (_: unknown, record: ExcelIntegrityItem) => {
                  const check = record.checkResults[idx];
                  return check?.exists ? (
                    <Tag color="success">✓</Tag>
                  ) : (
                    <Tag color="error">✗</Tag>
                  );
                },
              })),
            ]}
            rowKey="rowIndex"
            size="small"
            virtual
                    scroll={{ y: 360 }}
                    pagination={{ pageSize: 50, showSizeChanger: true }}
            title={() => <Text strong>{t('excel.match.missingListTitle')}</Text>}
            rowClassName={(record) => (!record.isComplete ? 'row-missing' : '')}
          />
        </Card>
      )}
  
      {/* 扫描模式的检查结果 */}
      {integritySource === 'folder' && integrityResult && (
        <Card size="small" title={t('excel.integrity.resultTitle')}>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={8}>
              <Statistic title={t('excel.integrity.statTotalFolders')} value={integrityResult.totalFolders} />
            </Col>
            <Col span={8}>
              <Statistic
                title={t('excel.integrity.statComplete')}
                value={integrityResult.completeCount}
                valueStyle={{ color: '#52c41a' }}
                prefix={<CheckCircleOutlined />}
              />
            </Col>
            <Col span={8}>
              <Statistic
                title={t('excel.integrity.statusMissing')}
                value={integrityResult.incompleteCount}
                valueStyle={{ color: '#ff4d4f' }}
                prefix={<CloseCircleOutlined />}
              />
            </Col>
          </Row>
  
          {integrityResult.outputPath && (
            <Alert
              type="success"
              message={t('excel.integrity.reportSavedAlert', { path: integrityResult.outputPath })}
              style={{ marginBottom: 16 }}
            />
          )}
  
          <Table
            dataSource={integrityResult.results}
            columns={integrityColumns}
            rowKey="folderPath"
            size="small"
            virtual
                    scroll={{ y: 360 }}
                    pagination={{ pageSize: 50, showSizeChanger: true }}
            rowClassName={(record) => (record.isComplete ? '' : 'row-missing')}
          />
        </Card>
      )}
    </Space>
  );

  const tabItems = [
    {
      key: 'match',
      label: (
        <span>
          <FileExcelOutlined />
          {t('excel.tabMatch')}
        </span>
      ),
      children: renderMatchTab(),
    },
    {
      key: 'integrity',
      label: (
        <span>
          <FolderOpenOutlined />
          {t('excel.tabIntegrity')}
        </span>
      ),
      children: renderIntegrityTab(),
    },
  ];

  return (
    <div style={{ 
      padding: 16, 
      height: '100%', 
      display: 'flex', 
      flexDirection: 'column',
      overflow: 'hidden' 
    }}>
      <Title level={4} style={{ marginBottom: 16, flexShrink: 0 }}>
        <FileExcelOutlined /> {t('excel.pageTitle')}
      </Title>

      {(matching || checking) && checkProgress && (
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
            <Button danger icon={<StopOutlined />} onClick={handleCancelCheck}>
              {t('excel.progress.cancel')}
            </Button>
          </Space>
        </Card>
      )}

      <Tabs 
        items={tabItems} 
        style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
        className="excel-check-tabs"
      />

      {/* 远程文件夹选择器 */}
      <RemoteFolderSelector
        open={remoteSelectorVisible}
        onClose={() => setRemoteSelectorVisible(false)}
        onSelect={handleRemoteSelect}
      />

      {/* 保存配置弹窗 */}
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
                <div><strong>{t('excel.config.previewTitle')}</strong></div>
                <div>{t('excel.config.previewTargetFolder', { path: integrityFolder || t('excel.config.previewNotSelected') })}</div>
                <div>{t('excel.config.previewTemplates', { count: templates.length })}</div>
                <div>{t('excel.config.previewNameExtract', { mode: namePattern === 'auto' ? t('excel.config.previewNameExtractAuto') : t('excel.config.previewNameExtractFull') })}</div>
              </>
            }
          />
        </Space>
      </Modal>

      <style>{`
        .row-missing {
          background-color: #fff2f0 !important;
        }
        .row-missing:hover > td {
          background-color: #ffccc7 !important;
        }
        .excel-check-tabs .ant-tabs-content-holder {
          flex: 1;
          overflow: auto;
          min-height: 0;
        }
        .excel-check-tabs .ant-tabs-content {
          height: 100%;
        }
        .excel-check-tabs .ant-tabs-tabpane {
          height: 100%;
        }
      `}</style>
    </div>
  );
};

export default ExcelCheck;
