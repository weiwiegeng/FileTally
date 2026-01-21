import React, { useState } from 'react';
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
} from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
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
}

// 转换为 Ant Design Tree 数据格式
interface TreeDataNode {
  key: string;
  title: React.ReactNode;
  icon?: React.ReactNode;
  children?: TreeDataNode[];
  isLeaf?: boolean;
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

  // 完整性检查状态
  const [integrityFolder, setIntegrityFolder] = useState<string>('');
  const [integrityIsRemote, setIntegrityIsRemote] = useState(false);
  const [templates, setTemplates] = useState<string[]>(['{name}.docx', '{name}照片']);
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
      // 如果有目标文件夹，自动扫描
      if (config.targetFolder) {
        scanFolderTree(config.targetFolder, 'integrity');
      }
      message.success(`已加载配置: ${config.name}`);
    }
  };

  // 保存配置
  const handleSaveConfig = () => {
    if (!configName.trim()) {
      message.warning('请输入配置名称');
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
      message.success('配置已更新');
    } else {
      // 新建配置
      const id = addConfig({
        name: configName,
        targetFolder: integrityFolder,
        templates,
        namePattern,
      });
      selectConfig(id);
      message.success('配置已保存');
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
    message.success('配置已删除');
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

  // 扫描文件夹树
  const scanFolderTree = async (folderPath: string, target: 'match' | 'integrity') => {
    setScanningTree(true);
    try {
      const result = await invoke<FolderTreeResult>('scan_folder_tree', {
        folderPath,
        maxDepth: null, // 不限制层数，显示所有
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
    } catch (error) {
      console.error('扫描文件夹失败:', error);
    } finally {
      setScanningTree(false);
    }
  };

  // 选择 Excel 文件
  const handleSelectExcel = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }],
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
      message.error(`打开文件失败: ${error}`);
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
      message.error(`读取工作表失败: ${error}`);
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
      message.error(`选择文件夹失败: ${error}`);
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
    } else {
      setIntegrityFolder(path);
      setIntegrityIsRemote(true);
    }
    setRemoteSelectorVisible(false);
  };

  // 执行 Excel 比对
  const handleMatch = async () => {
    if (!excelPath || selectedColumn === null || !targetFolder) {
      message.warning('请先选择 Excel 文件、匹配列和目标文件夹');
      return;
    }

    setMatching(true);
    try {
      // 先获取保存路径
      const outputPath = await save({
        defaultPath: excelPath.replace(/\.xlsx?$/i, '_标注结果.xlsx'),
        filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      });

      const result = await invoke<ExcelMatchResult>('match_excel_with_folder', {
        excelPath,
        sheetIndex: selectedSheet,
        columnIndex: selectedColumn,
        folderPath: targetFolder,
        matchMode,
        markColor,
        outputPath,
      });

      setMatchResult(result);

      if (result.outputPath) {
        message.success(`比对完成，结果已保存到: ${result.outputPath}`);
      } else {
        message.success('比对完成');
      }
    } catch (error) {
      message.error(`比对失败: ${error}`);
    } finally {
      setMatching(false);
    }
  };

  // 执行完整性检查
  const handleIntegrityCheck = async () => {
    if (!integrityFolder || templates.length === 0) {
      message.warning('请先选择目标文件夹和添加检查模板');
      return;
    }

    setChecking(true);
    try {
      // 获取保存路径
      const outputPath = await save({
        defaultPath: '完整性检查报告.xlsx',
        filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      });

      const result = await invoke<BatchIntegrityResult>('check_folder_integrity', {
        targetFolder: integrityFolder,
        templates,
        namePattern,
        outputPath,
      });

      setIntegrityResult(result);

      if (result.outputPath) {
        message.success(`检查完成，报告已保存到: ${result.outputPath}`);
      } else {
        message.success('检查完成');
      }
    } catch (error) {
      message.error(`检查失败: ${error}`);
    } finally {
      setChecking(false);
    }
  };

  // 选择完整性检查用的 Excel 文件
  const handleSelectIntegrityExcel = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }],
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
      message.error(`打开文件失败: ${error}`);
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
      message.error(`读取工作表失败: ${error}`);
    }
  };

  // 执行基于 Excel 的完整性检查
  const handleExcelIntegrityCheck = async () => {
    if (!integrityExcelPath || integrityNameColumn === null || !integrityFolder || templates.length === 0) {
      message.warning('请先选择 Excel 文件、姓名列、目标文件夹和检查模板');
      return;
    }

    setChecking(true);
    try {
      // 获取保存路径（默认保存到原文件同目录）
      const outputPath = await save({
        defaultPath: integrityExcelPath.replace(/\.xlsx?$/i, '_检查结果.xlsx'),
        filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      });

      const result = await invoke<ExcelIntegrityResult>('check_integrity_with_excel', {
        excelPath: integrityExcelPath,
        sheetIndex: integritySheet,
        nameColumnIndex: integrityNameColumn,
        targetFolder: integrityFolder,
        templates,
        folderMatchMode: integrityFolderMatchMode,
        outputPath,
      });

      setExcelIntegrityResult(result);

      if (result.outputPath) {
        message.success(`检查完成，结果已标注到: ${result.outputPath}`);
      } else {
        message.success('检查完成');
      }
    } catch (error) {
      message.error(`检查失败: ${error}`);
    } finally {
      setChecking(false);
    }
  };

  // 匹配结果表格列
  const matchColumns = [
    {
      title: '行号',
      dataIndex: 'rowIndex',
      key: 'rowIndex',
      width: 80,
    },
    {
      title: '值',
      dataIndex: 'value',
      key: 'value',
      ellipsis: true,
    },
    {
      title: '状态',
      dataIndex: 'matched',
      key: 'matched',
      width: 100,
      render: (matched: boolean) =>
        matched ? (
          <Tag color="success" icon={<CheckCircleOutlined />}>
            已匹配
          </Tag>
        ) : (
          <Tag color="error" icon={<CloseCircleOutlined />}>
            缺失
          </Tag>
        ),
    },
    {
      title: '匹配文件',
      dataIndex: 'matchedFile',
      key: 'matchedFile',
      ellipsis: true,
      render: (file: string | null) => file || '-',
    },
  ];

  // 完整性检查结果表格列
  const integrityColumns = [
    {
      title: '文件夹',
      dataIndex: 'folderName',
      key: 'folderName',
      ellipsis: true,
    },
    {
      title: '提取姓名',
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
      title: '状态',
      dataIndex: 'isComplete',
      key: 'isComplete',
      width: 80,
      render: (isComplete: boolean) =>
        isComplete ? (
          <Tag color="success">完整</Tag>
        ) : (
          <Tag color="error">缺失</Tag>
        ),
    },
  ];

  // Tab 1: Excel 比对
  const renderMatchTab = () => (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      {/* Excel 文件选择 */}
      <Card size="small" title="1. 选择 Excel 文件">
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space>
            <Button icon={<FileExcelOutlined />} onClick={handleSelectExcel}>
              选择 Excel 文件
            </Button>
            {excelPath && <Text type="secondary">{excelPath}</Text>}
          </Space>

          {excelInfo && (
            <>
              <Space>
                <Text>工作表:</Text>
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
                <Text type="secondary">共 {excelInfo.rowCount} 行数据</Text>
              </Space>

              <Space>
                <Text>匹配列:</Text>
                <Select
                  value={selectedColumn}
                  onChange={setSelectedColumn}
                  style={{ width: 300 }}
                  placeholder="选择要匹配的列"
                >
                  {excelInfo.columns.map((col) => (
                    <Select.Option key={col.index} value={col.index}>
                      {col.letter}列 - {col.name}
                      {col.sampleValues.length > 0 && (
                        <Text type="secondary"> (如: {col.sampleValues[0]})</Text>
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
      <Card size="small" title="2. 选择目标文件夹（递归搜索所有子文件夹）">
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space>
            <Button icon={<FolderOpenOutlined />} onClick={() => handleSelectFolder('match')}>
              本地文件夹
            </Button>
            <Button icon={<CloudOutlined />} onClick={() => handleSelectRemote('match')}>
              远程文件夹
            </Button>
            {targetFolder && (
              <Tag color={isRemote ? 'blue' : 'default'}>
                {isRemote ? '远程: ' : ''}{targetFolder}
              </Tag>
            )}
          </Space>

          {/* 文件树预览 */}
          {targetFolder && !isRemote && (
            <div style={{ marginTop: 8 }}>
              {scanningTree ? (
                <Spin tip="扫描中..." />
              ) : matchFolderTree && matchFolderTree.length > 0 ? (
                <>
                  <div style={{ marginBottom: 8 }}>
                    <Text type="secondary">
                      共 {matchTreeInfo?.folders} 个文件夹，{matchTreeInfo?.files} 个文件
                    </Text>
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
      <Card size="small" title="3. 匹配选项">
        <Space size="large">
          <Space>
            <Text>匹配方式:</Text>
            <Radio.Group value={matchMode} onChange={(e) => setMatchMode(e.target.value)}>
              <Radio.Button value="exact">精确匹配</Radio.Button>
              <Radio.Button value="contains">包含匹配</Radio.Button>
              <Radio.Button value="starts_with">前缀匹配</Radio.Button>
            </Radio.Group>
          </Space>

          <Space>
            <Text>标注颜色:</Text>
            <Radio.Group value={markColor} onChange={(e) => setMarkColor(e.target.value)}>
              <Radio.Button value="red" style={{ backgroundColor: markColor === 'red' ? '#ff6b6b' : undefined }}>
                红色
              </Radio.Button>
              <Radio.Button value="yellow" style={{ backgroundColor: markColor === 'yellow' ? '#ffe66d' : undefined }}>
                黄色
              </Radio.Button>
              <Radio.Button value="green" style={{ backgroundColor: markColor === 'green' ? '#6bcb77' : undefined }}>
                绿色
              </Radio.Button>
            </Radio.Group>
          </Space>
        </Space>
      </Card>

      {/* 执行按钮 */}
      <Button
        type="primary"
        size="large"
        icon={<SearchOutlined />}
        onClick={handleMatch}
        loading={matching}
        disabled={!excelPath || selectedColumn === null || !targetFolder}
        block
      >
        开始比对并导出
      </Button>

      {/* 匹配结果 */}
      {matchResult && (
        <Card size="small" title="比对结果">
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={8}>
              <Statistic title="总行数" value={matchResult.totalRows} />
            </Col>
            <Col span={8}>
              <Statistic
                title="已匹配"
                value={matchResult.matchedCount}
                valueStyle={{ color: '#52c41a' }}
                prefix={<CheckCircleOutlined />}
              />
            </Col>
            <Col span={8}>
              <Statistic
                title="缺失"
                value={matchResult.missingCount}
                valueStyle={{ color: '#ff4d4f' }}
                prefix={<CloseCircleOutlined />}
              />
            </Col>
          </Row>

          {matchResult.outputPath && (
            <Alert
              type="success"
              message={`标注后的 Excel 已保存到: ${matchResult.outputPath}`}
              style={{ marginBottom: 16 }}
            />
          )}

          <Table
            dataSource={matchResult.items.filter((item) => !item.matched)}
            columns={matchColumns}
            rowKey="rowIndex"
            size="small"
            pagination={{ pageSize: 10 }}
            title={() => <Text strong>缺失项列表</Text>}
          />
        </Card>
      )}
    </Space>
  );

  // Tab 2: 完整性检查
  const renderIntegrityTab = () => (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      {/* 名单来源选择 */}
      <Card size="small" title="1. 选择检查名单来源">
        <Space direction="vertical" style={{ width: '100%' }}>
          <Radio.Group 
            value={integritySource} 
            onChange={(e) => setIntegritySource(e.target.value)}
            buttonStyle="solid"
          >
            <Radio.Button value="excel">
              <FileExcelOutlined /> 从 Excel 导入名单
            </Radio.Button>
            <Radio.Button value="folder">
              <FolderOpenOutlined /> 从文件夹扫描
            </Radio.Button>
          </Radio.Group>
  
          {integritySource === 'excel' ? (
            <>
              <Space>
                <Button icon={<FileExcelOutlined />} onClick={handleSelectIntegrityExcel}>
                  选择 Excel 文件
                </Button>
                {integrityExcelPath && <Text type="secondary">{integrityExcelPath}</Text>}
              </Space>
  
              {integrityExcelInfo && (
                <>
                  <Space>
                    <Text>工作表:</Text>
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
                    <Text type="secondary">共 {integrityExcelInfo.rowCount} 行数据</Text>
                  </Space>
  
                  <Space>
                    <Text>姓名列:</Text>
                    <Select
                      value={integrityNameColumn}
                      onChange={setIntegrityNameColumn}
                      style={{ width: 300 }}
                      placeholder="选择包含姓名的列"
                    >
                      {integrityExcelInfo.columns.map((col) => (
                        <Select.Option key={col.index} value={col.index}>
                          {col.letter}列 - {col.name}
                          {col.sampleValues.length > 0 && (
                            <Text type="secondary"> (如: {col.sampleValues[0]})</Text>
                          )}
                        </Select.Option>
                      ))}
                    </Select>
                  </Space>
  
                  <Space>
                    <Text>文件夹匹配方式:</Text>
                    <Radio.Group value={integrityFolderMatchMode} onChange={(e) => setIntegrityFolderMatchMode(e.target.value)}>
                      <Radio.Button value="contains">包含匹配</Radio.Button>
                      <Radio.Button value="exact">精确匹配</Radio.Button>
                      <Radio.Button value="starts_with">前缀匹配</Radio.Button>
                    </Radio.Group>
                  </Space>
                </>
              )}
            </>
          ) : (
            <Alert
              type="info"
              message="扫描模式将自动遍历目标文件夹下的所有子文件夹，并从文件夹名提取姓名进行检查"
            />
          )}
        </Space>
      </Card>
  
      {/* 目标文件夹选择 */}
      <Card size="small" title="2. 选择要检查的文件夹（检查所有子文件夹）">
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space>
            <Button icon={<FolderOpenOutlined />} onClick={() => handleSelectFolder('integrity')}>
              本地文件夹
            </Button>
            <Button icon={<CloudOutlined />} onClick={() => handleSelectRemote('integrity')}>
              远程文件夹
            </Button>
            {integrityFolder && (
              <Tag color={integrityIsRemote ? 'blue' : 'default'}>
                {integrityIsRemote ? '远程: ' : ''}{integrityFolder}
              </Tag>
            )}
          </Space>
  
          {/* 文件树预览 */}
          {integrityFolder && !integrityIsRemote && (
            <div style={{ marginTop: 8 }}>
              {scanningTree ? (
                <Spin tip="扫描中..." />
              ) : integrityFolderTree && integrityFolderTree.length > 0 ? (
                <>
                  <div style={{ marginBottom: 8 }}>
                    <Text type="secondary">
                      共 {integrityTreeInfo?.folders} 个子文件夹，{integrityTreeInfo?.files} 个文件
                    </Text>
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
      <Card size="small" title="3. 配置必需文件模板">
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert
            type="info"
            message="使用 {name} 作为姓名占位符，如：{name}.docx 会被替换为 张三.docx。每行一个模板。"
            style={{ marginBottom: 8 }}
          />
  
          <TextArea
            placeholder="每行输入一个模板，例如：\n{name}.docx\n{name}照片\n{name}身份证.jpg"
            value={templates.join('\n')}
            onChange={(e) => {
              const lines = e.target.value.split('\n').filter(line => line.trim());
              setTemplates(lines);
            }}
            rows={4}
            style={{ width: '100%', fontFamily: 'monospace' }}
          />
  
          <Text type="secondary">当前模板数量：{templates.length} 个</Text>
        </Space>
      </Card>
  
      {/* 姓名提取规则 - 仅扫描模式显示 */}
      {integritySource === 'folder' && (
        <Card size="small" title="4. 姓名提取规则">
          <Space>
            <Text>从文件夹名提取姓名:</Text>
            <Radio.Group value={namePattern} onChange={(e) => setNamePattern(e.target.value)}>
              <Radio.Button value="auto">自动提取中文</Radio.Button>
              <Radio.Button value="">使用完整名称</Radio.Button>
            </Radio.Group>
          </Space>
          <div style={{ marginTop: 8 }}>
            <Text type="secondary">
              自动提取示例: "2025-0001王宏琳" → "王宏琳"
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
          integritySource === 'excel'
            ? (!integrityExcelPath || integrityNameColumn === null || !integrityFolder || templates.length === 0)
            : (!integrityFolder || templates.length === 0)
        }
        block
      >
        {integritySource === 'excel' ? '开始检查并标注到 Excel' : '开始检查并导出报告'}
      </Button>
  
      {/* 基于 Excel 的检查结果 */}
      {integritySource === 'excel' && excelIntegrityResult && (
        <Card size="small" title="检查结果">
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={6}>
              <Statistic title="总行数" value={excelIntegrityResult.totalRows} />
            </Col>
            <Col span={6}>
              <Statistic
                title="完整"
                value={excelIntegrityResult.completeCount}
                valueStyle={{ color: '#52c41a' }}
                prefix={<CheckCircleOutlined />}
              />
            </Col>
            <Col span={6}>
              <Statistic
                title="缺失文件"
                value={excelIntegrityResult.incompleteCount}
                valueStyle={{ color: '#ff4d4f' }}
                prefix={<CloseCircleOutlined />}
              />
            </Col>
            <Col span={6}>
              <Statistic
                title="未找到文件夹"
                value={excelIntegrityResult.notFoundCount}
                valueStyle={{ color: '#faad14' }}
              />
            </Col>
          </Row>
  
          {excelIntegrityResult.outputPath && (
            <Alert
              type="success"
              message={`检查结果已标注到: ${excelIntegrityResult.outputPath}`}
              style={{ marginBottom: 16 }}
            />
          )}
  
          <Table
            dataSource={excelIntegrityResult.items.filter(item => !item.isComplete)}
            columns={[
              { title: '行号', dataIndex: 'rowIndex', key: 'rowIndex', width: 60 },
              { title: '姓名', dataIndex: 'name', key: 'name', width: 100 },
              {
                title: '文件夹',
                key: 'folder',
                width: 120,
                render: (_: unknown, record: ExcelIntegrityItem) => 
                  record.folderFound ? (
                    <Tag color="success">已找到</Tag>
                  ) : (
                    <Tag color="warning">未找到</Tag>
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
            pagination={{ pageSize: 10 }}
            title={() => <Text strong>缺失项列表</Text>}
            rowClassName={(record) => (!record.isComplete ? 'row-missing' : '')}
          />
        </Card>
      )}
  
      {/* 扫描模式的检查结果 */}
      {integritySource === 'folder' && integrityResult && (
        <Card size="small" title="检查结果">
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={8}>
              <Statistic title="总文件夹数" value={integrityResult.totalFolders} />
            </Col>
            <Col span={8}>
              <Statistic
                title="完整"
                value={integrityResult.completeCount}
                valueStyle={{ color: '#52c41a' }}
                prefix={<CheckCircleOutlined />}
              />
            </Col>
            <Col span={8}>
              <Statistic
                title="缺失"
                value={integrityResult.incompleteCount}
                valueStyle={{ color: '#ff4d4f' }}
                prefix={<CloseCircleOutlined />}
              />
            </Col>
          </Row>
  
          {integrityResult.outputPath && (
            <Alert
              type="success"
              message={`检查报告已保存到: ${integrityResult.outputPath}`}
              style={{ marginBottom: 16 }}
            />
          )}
  
          <Table
            dataSource={integrityResult.results}
            columns={integrityColumns}
            rowKey="folderPath"
            size="small"
            pagination={{ pageSize: 10 }}
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
          Excel 比对
        </span>
      ),
      children: renderMatchTab(),
    },
    {
      key: 'integrity',
      label: (
        <span>
          <FolderOpenOutlined />
          完整性检查
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
        <FileExcelOutlined /> 智能检查
      </Title>

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
        title={editingConfigId ? '更新配置' : '保存配置'}
        open={saveConfigModalVisible}
        onOk={handleSaveConfig}
        onCancel={() => {
          setSaveConfigModalVisible(false);
          setConfigName('');
          setEditingConfigId(null);
        }}
        okText="保存"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>
            <Text strong>配置名称</Text>
            <Input
              placeholder="请输入配置名称，如：案件归档检查"
              value={configName}
              onChange={(e) => setConfigName(e.target.value)}
              style={{ marginTop: 8 }}
            />
          </div>
          <Alert
            type="info"
            message={
              <>
                <div><strong>将保存的内容：</strong></div>
                <div>目标文件夹: {integrityFolder || '(未选择)'}</div>
                <div>检查模板: {templates.length} 个</div>
                <div>姓名提取: {namePattern === 'auto' ? '自动提取中文' : '使用完整名称'}</div>
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
