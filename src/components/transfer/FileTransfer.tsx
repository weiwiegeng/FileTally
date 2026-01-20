import React, { useState } from 'react';
import {
  Card,
  Button,
  Space,
  Typography,
  List,
  Empty,
  Progress,
  Tag,
  Tooltip,
  Alert,
  Row,
  Col,
  Statistic,
  Divider,
  Result,
  Segmented,
} from 'antd';
import {
  UploadOutlined,
  FolderOpenOutlined,
  CloudServerOutlined,
  DeleteOutlined,
  SendOutlined,
  FileOutlined,
  FolderOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  SwapRightOutlined,
  ReloadOutlined,
  RightOutlined,
  DownOutlined,
  LoadingOutlined,
  DownloadOutlined,
  DesktopOutlined,
} from '@ant-design/icons';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useTransferStore, useRemoteStore, TransferItem, TransferDirection } from '../../stores';
import { useThemeColors } from '../../hooks';
import { RemoteFolderSelector } from '../search/RemoteFolderSelector';
import { ConflictModal } from './ConflictModal';
import { getPathName } from '../../utils/format';

const { Title, Text, Paragraph } = Typography;

// 获取文件信息
interface FileInfo {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
}

export const FileTransfer: React.FC = () => {
  const {
    direction,
    sourceItems,
    sourceConnectionName,
    targetPath,
    targetConnectionName,
    loading,
    transferring,
    progress,
    result,
    error,
    setDirection,
    addSourceItems,
    removeSourceItem,
    clearSourceItems,
    setTargetPath,
    clearTargetPath,
    checkConflicts,
    startTransfer,
    reset,
  } = useTransferStore();
  const { connections } = useRemoteStore();
  const colors = useThemeColors();

  const [showRemoteSelector, setShowRemoteSelector] = useState(false);
  const [showRemoteFileSelector, setShowRemoteFileSelector] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [folderContents, setFolderContents] = useState<Map<string, TransferItem[]>>(new Map());
  const [loadingFolders, setLoadingFolders] = useState<Set<string>>(new Set());

  // 选择本地文件
  const handleSelectFiles = async () => {
    try {
      const selected = await open({
        multiple: true,
        directory: false,
        title: direction === 'upload' ? '选择要上传的文件' : '选择保存位置',
      });
      
      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected];
        const items: TransferItem[] = [];
        
        for (const path of paths) {
          try {
            const info = await invoke<{ size: number; sizeFormatted: string; isDir: boolean; name: string }>('get_path_info', { path });
            items.push({
              id: '',
              sourcePath: path,
              fileName: info.name,
              fileType: info.isDir ? 'folder' : 'file',
              size: info.size,
              sizeFormatted: info.sizeFormatted,
            });
          } catch {
            // 忽略错误，继续处理其他文件
          }
        }
        
        addSourceItems(items);
      }
    } catch (err) {
      console.error('选择文件失败:', err);
    }
  };

  // 选择本地文件夹
  const handleSelectFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: direction === 'upload' ? '选择要上传的文件夹' : '选择保存位置',
      });
      
      if (selected) {
        try {
          const info = await invoke<{ size: number; sizeFormatted: string; isDir: boolean; name: string }>('get_path_info', { path: selected as string });
          // 获取文件夹内容
          const contents = await invoke<Array<{ path: string; name: string; isDir: boolean; size: number; sizeFormatted: string }>>('list_folder_contents', { path: selected as string });
          const children: TransferItem[] = contents.map(item => ({
            id: '',
            sourcePath: item.path,
            fileName: item.name,
            fileType: item.isDir ? 'folder' : 'file',
            size: item.size,
            sizeFormatted: item.sizeFormatted,
            level: 1,
          }));
          
          addSourceItems([{
            id: '',
            sourcePath: selected as string,
            fileName: info.name,
            fileType: 'folder',
            size: info.size,
            sizeFormatted: info.sizeFormatted,
            children,
            expanded: true,
            level: 0,
          }]);
        } catch {
          // 如果获取信息失败，使用默认值
          const name = getPathName(selected as string) || selected;
          addSourceItems([{
            id: '',
            sourcePath: selected as string,
            fileName: name as string,
            fileType: 'folder',
            size: 0,
            sizeFormatted: '计算中...',
            level: 0,
          }]);
        }
      }
    } catch (err) {
      console.error('选择文件夹失败:', err);
    }
  };

  // 切换文件夹展开/收起
  const toggleFolderExpand = async (item: TransferItem) => {
    const folderId = item.id;
    const newExpanded = new Set(expandedFolders);
    
    if (expandedFolders.has(folderId)) {
      newExpanded.delete(folderId);
    } else {
      newExpanded.add(folderId);
      
      // 如果还没有加载过内容，则加载
      if (!folderContents.has(folderId) && !item.children) {
        setLoadingFolders(prev => new Set(prev).add(folderId));
        try {
          const contents = await invoke<Array<{ path: string; name: string; isDir: boolean; size: number; sizeFormatted: string }>>('list_folder_contents', { path: item.sourcePath });
          const children: TransferItem[] = contents.map((c, idx) => ({
            id: `${folderId}_${idx}`,
            sourcePath: c.path,
            fileName: c.name,
            fileType: c.isDir ? 'folder' : 'file',
            size: c.size,
            sizeFormatted: c.sizeFormatted,
            level: (item.level || 0) + 1,
          }));
          setFolderContents(prev => new Map(prev).set(folderId, children));
        } catch (err) {
          console.error('加载文件夹内容失败:', err);
        } finally {
          setLoadingFolders(prev => {
            const next = new Set(prev);
            next.delete(folderId);
            return next;
          });
        }
      }
    }
    
    setExpandedFolders(newExpanded);
  };

  // 开始传输
  const handleStartTransfer = async () => {
    const hasConflicts = await checkConflicts();
    if (!hasConflicts) {
      // 无冲突，直接开始传输
      startTransfer('overwrite');
    }
    // 有冲突时会自动显示冲突弹窗
  };

  // 计算总大小
  const totalSize = sourceItems.reduce((sum, item) => sum + item.size, 0);
  const formatSize = (size: number): string => {
    const KB = 1024;
    const MB = KB * 1024;
    const GB = MB * 1024;
    if (size >= GB) return `${(size / GB).toFixed(2)} GB`;
    if (size >= MB) return `${(size / MB).toFixed(2)} MB`;
    if (size >= KB) return `${(size / KB).toFixed(2)} KB`;
    return `${size} B`;
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
          {direction === 'upload' ? (
            <UploadOutlined style={{ fontSize: 24, color: colors.accentBlue }} />
          ) : (
            <DownloadOutlined style={{ fontSize: 24, color: colors.accentGreen }} />
          )}
          <Title level={4} style={{ margin: 0, color: colors.textPrimary }}>
            文件传输
          </Title>
        </Space>
        <Space>
          <Segmented
            options={[
              { label: '上传', value: 'upload', icon: <UploadOutlined /> },
              { label: '下载', value: 'download', icon: <DownloadOutlined /> },
            ]}
            value={direction}
            onChange={(val) => setDirection(val as TransferDirection)}
          />
          {(sourceItems.length > 0 || targetPath) && (
            <Button icon={<ReloadOutlined />} onClick={reset}>
              重置
            </Button>
          )}
        </Space>
      </div>

      {/* Content */}
      <div style={{ flex: 1, padding: 24, overflow: 'auto' }}>
        {/* 传输结果 */}
        {result && (
          <Alert
            type={result.success ? 'success' : 'warning'}
            message={result.success ? '传输完成' : '传输完成（部分失败）'}
            description={
              <Space direction="vertical">
                <Text>成功: {result.transferred} 个文件</Text>
                {result.skipped > 0 && <Text>跳过: {result.skipped} 个文件</Text>}
                {result.failed > 0 && <Text type="danger">失败: {result.failed} 个文件</Text>}
                {result.errors.length > 0 && (
                  <div>
                    {result.errors.map((err, idx) => (
                      <Text key={idx} type="danger" style={{ display: 'block', fontSize: 12 }}>
                        {err}
                      </Text>
                    ))}
                  </div>
                )}
              </Space>
            }
            showIcon
            closable
            style={{ marginBottom: 16 }}
          />
        )}

        {error && (
          <Alert
            type="error"
            message="传输错误"
            description={error}
            showIcon
            closable
            style={{ marginBottom: 16 }}
          />
        )}

        <Row gutter={24}>
          {/* 左侧：源文件选择 */}
          <Col span={12}>
            <Card
              title={
                <Space>
                  {direction === 'upload' ? (
                    <>
                      <FolderOpenOutlined style={{ color: colors.accentOrange }} />
                      <span>本地文件</span>
                    </>
                  ) : (
                    <>
                      <CloudServerOutlined style={{ color: colors.accentPurple }} />
                      <span>远程文件 (NAS)</span>
                      {sourceConnectionName && (
                        <Tag color="purple" style={{ marginLeft: 8 }}>{sourceConnectionName}</Tag>
                      )}
                    </>
                  )}
                </Space>
              }
              extra={
                direction === 'upload' ? (
                  <Space>
                    <Button
                      icon={<FileOutlined />}
                      onClick={handleSelectFiles}
                      size="small"
                    >
                      选择文件
                    </Button>
                    <Button
                      icon={<FolderOutlined />}
                      onClick={handleSelectFolder}
                      size="small"
                    >
                      选择文件夹
                    </Button>
                  </Space>
                ) : (
                  <Button
                    icon={<FolderOpenOutlined />}
                    onClick={() => setShowRemoteFileSelector(true)}
                    size="small"
                    disabled={connections.length === 0}
                  >
                    选择远程文件
                  </Button>
                )
              }
              style={{ background: colors.bgCard, height: 400 }}
              bodyStyle={{ height: 'calc(100% - 57px)', overflow: 'auto', padding: '12px 16px' }}
            >
              {sourceItems.length === 0 ? (
                direction === 'download' && connections.length === 0 ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="请先在远程连接页面添加 NAS 连接"
                  />
                ) : (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={direction === 'upload' ? "点击上方按钮选择要上传的文件或文件夹" : "点击上方按钮选择要下载的远程文件"}
                  />
                )
              ) : (
                <div>
                  {sourceItems.map((item) => {
                    const isExpanded = item.expanded || expandedFolders.has(item.id);
                    const isLoading = loadingFolders.has(item.id);
                    const children = item.children || folderContents.get(item.id) || [];
                    
                    return (
                      <div key={item.id}>
                        {/* 主项目 */}
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            padding: '8px 0',
                            borderBottom: `1px solid ${colors.border}`,
                            paddingLeft: (item.level || 0) * 20,
                          }}
                        >
                          {/* 展开/收起按钮 */}
                          {item.fileType === 'folder' ? (
                            <Button
                              type="text"
                              size="small"
                              icon={isLoading ? <LoadingOutlined /> : isExpanded ? <DownOutlined /> : <RightOutlined />}
                              onClick={() => toggleFolderExpand(item)}
                              style={{ marginRight: 4, width: 24, padding: 0 }}
                            />
                          ) : (
                            <span style={{ width: 28 }} />
                          )}
                          
                          {/* 图标 */}
                          {item.fileType === 'folder' ? (
                            <FolderOutlined style={{ fontSize: 18, color: colors.accentOrange, marginRight: 8 }} />
                          ) : (
                            <FileOutlined style={{ fontSize: 18, color: colors.accentBlue, marginRight: 8 }} />
                          )}
                          
                          {/* 文件名 */}
                          <Tooltip title={item.sourcePath}>
                            <Text ellipsis style={{ flex: 1, maxWidth: 180 }}>{item.fileName}</Text>
                          </Tooltip>
                          
                          {/* 大小 */}
                          <Text type="secondary" style={{ fontSize: 12, marginLeft: 8, minWidth: 70, textAlign: 'right' }}>
                            {item.sizeFormatted || '计算中...'}
                          </Text>
                          
                          {/* 删除按钮（只显示在顶级） */}
                          {(item.level || 0) === 0 && (
                            <Button
                              type="text"
                              danger
                              icon={<DeleteOutlined />}
                              size="small"
                              onClick={() => removeSourceItem(item.id)}
                              style={{ marginLeft: 8 }}
                            />
                          )}
                        </div>
                        
                        {/* 子项目 */}
                        {item.fileType === 'folder' && isExpanded && children.length > 0 && (
                          <div>
                            {children.map((child, idx) => {
                              const childId = child.id || `${item.id}_child_${idx}`;
                              const childIsExpanded = expandedFolders.has(childId);
                              const childIsLoading = loadingFolders.has(childId);
                              const childChildren = folderContents.get(childId) || [];
                              
                              return (
                                <div key={childId}>
                                  <div
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      padding: '6px 0',
                                      borderBottom: `1px solid ${colors.border}`,
                                      paddingLeft: ((child.level || 1)) * 20,
                                      background: colors.bgHover,
                                    }}
                                  >
                                    {child.fileType === 'folder' ? (
                                      <Button
                                        type="text"
                                        size="small"
                                        icon={childIsLoading ? <LoadingOutlined /> : childIsExpanded ? <DownOutlined /> : <RightOutlined />}
                                        onClick={() => toggleFolderExpand({ ...child, id: childId })}
                                        style={{ marginRight: 4, width: 24, padding: 0 }}
                                      />
                                    ) : (
                                      <span style={{ width: 28 }} />
                                    )}
                                    
                                    {child.fileType === 'folder' ? (
                                      <FolderOutlined style={{ fontSize: 16, color: colors.accentOrange, marginRight: 8 }} />
                                    ) : (
                                      <FileOutlined style={{ fontSize: 16, color: colors.accentBlue, marginRight: 8 }} />
                                    )}
                                    
                                    <Tooltip title={child.sourcePath}>
                                      <Text ellipsis style={{ flex: 1, maxWidth: 160, fontSize: 13 }}>{child.fileName}</Text>
                                    </Tooltip>
                                    
                                    <Text type="secondary" style={{ fontSize: 11, marginLeft: 8, minWidth: 70, textAlign: 'right' }}>
                                      {child.sizeFormatted}
                                    </Text>
                                  </div>
                                  
                                  {/* 二级子项目 */}
                                  {child.fileType === 'folder' && childIsExpanded && childChildren.length > 0 && (
                                    <div>
                                      {childChildren.map((grandChild, gIdx) => (
                                        <div
                                          key={`${childId}_grand_${gIdx}`}
                                          style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            padding: '4px 0',
                                            borderBottom: `1px solid ${colors.border}`,
                                            paddingLeft: ((grandChild.level || 2)) * 20,
                                            background: colors.bgCard,
                                          }}
                                        >
                                          <span style={{ width: 28 }} />
                                          {grandChild.fileType === 'folder' ? (
                                            <FolderOutlined style={{ fontSize: 14, color: colors.accentOrange, marginRight: 8 }} />
                                          ) : (
                                            <FileOutlined style={{ fontSize: 14, color: colors.accentBlue, marginRight: 8 }} />
                                          )}
                                          <Tooltip title={grandChild.sourcePath}>
                                            <Text ellipsis style={{ flex: 1, maxWidth: 140, fontSize: 12 }}>{grandChild.fileName}</Text>
                                          </Tooltip>
                                          <Text type="secondary" style={{ fontSize: 11, marginLeft: 8, minWidth: 70, textAlign: 'right' }}>
                                            {grandChild.sizeFormatted}
                                          </Text>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
            
            {sourceItems.length > 0 && (
              <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between' }}>
                <Text type="secondary">
                  已选择 {sourceItems.length} 个项目
                  {totalSize > 0 && `，共 ${formatSize(totalSize)}`}
                </Text>
                <Button size="small" danger onClick={clearSourceItems}>
                  清空列表
                </Button>
              </div>
            )}
          </Col>

          {/* 右侧：目标选择 */}
          <Col span={12}>
            <Card
              title={
                <Space>
                  {direction === 'upload' ? (
                    <>
                      <CloudServerOutlined style={{ color: colors.accentPurple }} />
                      <span>远程目标 (NAS)</span>
                    </>
                  ) : (
                    <>
                      <DesktopOutlined style={{ color: colors.accentOrange }} />
                      <span>本地目标</span>
                    </>
                  )}
                </Space>
              }
              extra={
                direction === 'upload' ? (
                  <Button
                    icon={<FolderOpenOutlined />}
                    onClick={() => setShowRemoteSelector(true)}
                    size="small"
                    disabled={connections.length === 0}
                  >
                    选择目录
                  </Button>
                ) : (
                  <Button
                    icon={<FolderOpenOutlined />}
                    onClick={async () => {
                      const selected = await open({
                        directory: true,
                        multiple: false,
                        title: '选择保存位置',
                      });
                      if (selected) {
                        setTargetPath(selected as string);
                      }
                    }}
                    size="small"
                  >
                    选择目录
                  </Button>
                )
              }
              style={{ background: colors.bgCard, height: 400 }}
              bodyStyle={{ height: 'calc(100% - 57px)', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}
            >
              {direction === 'upload' && connections.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="请先在远程连接页面添加 NAS 连接"
                />
              ) : !targetPath ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="点击上方按钮选择目标目录"
                />
              ) : (
                <div style={{ textAlign: 'center' }}>
                  {direction === 'upload' ? (
                    <CloudServerOutlined style={{ fontSize: 48, color: colors.accentPurple, marginBottom: 16 }} />
                  ) : (
                    <DesktopOutlined style={{ fontSize: 48, color: colors.accentOrange, marginBottom: 16 }} />
                  )}
                  <div>
                    {targetConnectionName && (
                      <Tag color="purple" style={{ marginBottom: 8 }}>{targetConnectionName}</Tag>
                    )}
                  </div>
                  <Paragraph
                    ellipsis={{ rows: 2 }}
                    style={{ color: colors.textPrimary, margin: 0 }}
                  >
                    {targetPath}
                  </Paragraph>
                  <Button
                    type="link"
                    size="small"
                    onClick={clearTargetPath}
                    style={{ marginTop: 8 }}
                  >
                    更换目录
                  </Button>
                </div>
              )}
            </Card>
          </Col>
        </Row>

        {/* 传输进度 */}
        {transferring && progress && (
          <Card style={{ marginTop: 24, background: colors.bgCard }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Text>正在传输: {progress.currentFile}</Text>
                <Text type="secondary">
                  {progress.currentIndex} / {progress.totalFiles}
                </Text>
              </div>
              <Progress percent={progress.percentage} status="active" />
            </Space>
          </Card>
        )}

        {/* 传输按钮 */}
        <div style={{ marginTop: 24, textAlign: 'center' }}>
          <Button
            type="primary"
            size="large"
            icon={direction === 'upload' ? <UploadOutlined /> : <DownloadOutlined />}
            onClick={handleStartTransfer}
            loading={loading || transferring}
            disabled={sourceItems.length === 0 || !targetPath}
            style={{ minWidth: 200 }}
          >
            {transferring ? '传输中...' : direction === 'upload' ? '开始上传' : '开始下载'}
          </Button>
        </div>
      </div>

      {/* 远程目录选择器（上传模式 - 选择目标） */}
      <RemoteFolderSelector
        open={showRemoteSelector}
        onClose={() => setShowRemoteSelector(false)}
        onSelect={(path, connectionName) => {
          setTargetPath(path, connectionName);
        }}
      />

      {/* 远程文件选择器（下载模式 - 选择源） */}
      <RemoteFolderSelector
        open={showRemoteFileSelector}
        onClose={() => setShowRemoteFileSelector(false)}
        onSelect={(path, connectionName) => {
          // 下载模式选择远程文件作为源
          invoke<{ size: number; sizeFormatted: string; isDir: boolean; name: string }>('get_path_info', { path })
            .then(info => {
              if (info.isDir) {
                // 如果是文件夹，获取内容
                invoke<Array<{ path: string; name: string; isDir: boolean; size: number; sizeFormatted: string }>>('list_folder_contents', { path })
                  .then(contents => {
                    const children: TransferItem[] = contents.map(item => ({
                      id: '',
                      sourcePath: item.path,
                      fileName: item.name,
                      fileType: item.isDir ? 'folder' : 'file',
                      size: item.size,
                      sizeFormatted: item.sizeFormatted,
                      level: 1,
                    }));
                    addSourceItems([{
                      id: '',
                      sourcePath: path,
                      fileName: info.name,
                      fileType: 'folder',
                      size: info.size,
                      sizeFormatted: info.sizeFormatted,
                      children,
                      expanded: true,
                      level: 0,
                    }], connectionName);
                  });
              } else {
                addSourceItems([{
                  id: '',
                  sourcePath: path,
                  fileName: info.name,
                  fileType: 'file',
                  size: info.size,
                  sizeFormatted: info.sizeFormatted,
                  level: 0,
                }], connectionName);
              }
            })
            .catch(console.error);
          setShowRemoteFileSelector(false);
        }}
      />

      {/* 冲突处理弹窗 */}
      <ConflictModal />
    </div>
  );
};
