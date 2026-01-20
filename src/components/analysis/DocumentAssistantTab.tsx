import React, { useState, useRef } from 'react';
import {
  Button,
  Space,
  Typography,
  Card,
  Input,
  Empty,
  Spin,
  message,
  Divider,
  Alert,
  List,
  Tag,
} from 'antd';
import {
  FileTextOutlined,
  SendOutlined,
  FileAddOutlined,
  DeleteOutlined,
  RobotOutlined,
  UserOutlined,
  SettingOutlined,
  CopyOutlined,
} from '@ant-design/icons';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../../stores';
import { useThemeColors } from '../../hooks';
import { getAIService, ChatMessage } from '../../services/aiService';

const { Text, Title, Paragraph } = Typography;
const { TextArea } = Input;

interface DocumentInfo {
  path: string;
  name: string;
  content: string;
  size: number;
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export const DocumentAssistantTab: React.FC = () => {
  const { settings } = useSettingsStore();
  const colors = useThemeColors();
  
  const [selectedDocument, setSelectedDocument] = useState<DocumentInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingDocument, setLoadingDocument] = useState(false);
  const [summary, setSummary] = useState<string>('');
  const [conversation, setConversation] = useState<ConversationMessage[]>([]);
  const [inputQuestion, setInputQuestion] = useState('');
  
  const conversationEndRef = useRef<HTMLDivElement>(null);

  // 检查 AI 是否配置
  const isAIConfigured = settings.aiConfig.apiKey || settings.aiConfig.provider === 'ollama';

  // 选择文档
  const handleSelectDocument = async () => {
    try {
      const selected = await open({
        multiple: false,
        title: '选择文档',
        filters: [
          { name: '文档', extensions: ['pdf', 'txt', 'md', 'json', 'xml', 'html'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      
      if (selected) {
        setLoadingDocument(true);
        setSummary('');
        setConversation([]);
        
        try {
          // 读取文件内容
          const preview = await invoke<{ content: string | null; metadata: { size: number; name: string } }>('get_file_preview', {
            path: selected,
          });
          
          const fileName = (selected as string).split('/').pop() || '';
          
          setSelectedDocument({
            path: selected as string,
            name: fileName,
            content: preview.content || '',
            size: preview.metadata.size,
          });
          
          if (!preview.content) {
            message.warning('无法读取文件内容，可能是二进制文件或编码问题');
          }
        } catch (err) {
          console.error('读取文件失败:', err);
          message.error('读取文件失败');
        } finally {
          setLoadingDocument(false);
        }
      }
    } catch (err) {
      console.error('选择文件失败:', err);
    }
  };

  // 生成摘要
  const handleGenerateSummary = async () => {
    if (!selectedDocument?.content) {
      message.error('请先选择一个有效的文档');
      return;
    }

    if (!isAIConfigured) {
      message.error('请先在设置中配置 AI 模型');
      return;
    }

    setLoading(true);
    try {
      const aiService = getAIService(settings.aiConfig);
      const result = await aiService.summarizeDocument(
        selectedDocument.content,
        selectedDocument.name
      );
      setSummary(result);
      message.success('摘要生成成功');
    } catch (err: any) {
      console.error('生成摘要失败:', err);
      message.error(`生成摘要失败: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // 发送问题
  const handleSendQuestion = async () => {
    if (!inputQuestion.trim()) return;
    
    if (!selectedDocument?.content) {
      message.error('请先选择一个有效的文档');
      return;
    }

    if (!isAIConfigured) {
      message.error('请先在设置中配置 AI 模型');
      return;
    }

    const question = inputQuestion.trim();
    setInputQuestion('');
    
    // 添加用户消息
    const userMessage: ConversationMessage = {
      role: 'user',
      content: question,
      timestamp: Date.now(),
    };
    setConversation(prev => [...prev, userMessage]);

    setLoading(true);
    try {
      const aiService = getAIService(settings.aiConfig);
      const result = await aiService.askAboutDocument(
        selectedDocument.content,
        selectedDocument.name,
        question
      );
      
      // 添加助手回复
      const assistantMessage: ConversationMessage = {
        role: 'assistant',
        content: result,
        timestamp: Date.now(),
      };
      setConversation(prev => [...prev, assistantMessage]);
      
      // 滚动到底部
      setTimeout(() => {
        conversationEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    } catch (err: any) {
      console.error('问答失败:', err);
      message.error(`问答失败: ${err.message}`);
      
      // 移除用户消息
      setConversation(prev => prev.slice(0, -1));
      setInputQuestion(question);
    } finally {
      setLoading(false);
    }
  };

  // 复制内容
  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    message.success('已复制到剪贴板');
  };

  // 清空对话
  const handleClearConversation = () => {
    setConversation([]);
    setSummary('');
  };

  // 格式化文件大小
  const formatSize = (size: number) => {
    const KB = 1024;
    const MB = KB * 1024;
    if (size >= MB) return `${(size / MB).toFixed(2)} MB`;
    if (size >= KB) return `${(size / KB).toFixed(2)} KB`;
    return `${size} B`;
  };

  return (
    <div style={{ padding: 24, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* AI 配置提示 */}
      {!isAIConfigured && (
        <Alert
          message="AI 未配置"
          description={
            <Space>
              <span>请先在设置中配置 AI 模型（API Key 或本地 Ollama）</span>
              <Button size="small" icon={<SettingOutlined />}>
                前往设置
              </Button>
            </Space>
          }
          type="warning"
          showIcon
          style={{ marginBottom: 16, flexShrink: 0 }}
        />
      )}

      {/* 文档选择区域 - 紧凑布局 */}
      <Card
        title={
          <Space>
            <FileTextOutlined style={{ color: colors.accentBlue }} />
            <span>选择文档</span>
          </Space>
        }
        extra={
          selectedDocument && (
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => {
                setSelectedDocument(null);
                setSummary('');
                setConversation([]);
              }}
            >
              清除
            </Button>
          )
        }
        style={{ marginBottom: 16, background: colors.bgCard, flexShrink: 0 }}
        size="small"
        bodyStyle={{ padding: selectedDocument ? '12px 16px' : undefined }}
      >
        {loadingDocument ? (
          <div style={{ textAlign: 'center', padding: 20 }}>
            <Spin />
            <div style={{ marginTop: 8 }}>
              <Text type="secondary">正在读取文档...</Text>
            </div>
          </div>
        ) : selectedDocument ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Space>
              <FileTextOutlined style={{ fontSize: 20, color: colors.accentOrange }} />
              <div>
                <Text strong>{selectedDocument.name}</Text>
                <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                  {formatSize(selectedDocument.size)} · {selectedDocument.content.length} 字符
                </Text>
              </div>
            </Space>
            <Space>
              <Button
                type="primary"
                size="small"
                icon={<RobotOutlined />}
                onClick={handleGenerateSummary}
                loading={loading && !conversation.length}
                disabled={!isAIConfigured}
              >
                生成摘要
              </Button>
              <Button size="small" icon={<FileAddOutlined />} onClick={handleSelectDocument}>
                更换
              </Button>
            </Space>
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <FileAddOutlined style={{ fontSize: 36, color: colors.border, marginBottom: 12 }} />
            <div>
              <Button type="primary" icon={<FileAddOutlined />} onClick={handleSelectDocument}>
                选择文档
              </Button>
            </div>
            <div style={{ marginTop: 8 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                支持 PDF、TXT、Markdown、JSON 等文本格式
              </Text>
            </div>
          </div>
        )}
      </Card>

      {/* 摘要区域 */}
      {summary && (
        <Card
          title={
            <Space>
              <RobotOutlined style={{ color: colors.accentGreen }} />
              <span>文档摘要</span>
            </Space>
          }
          extra={
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={() => handleCopy(summary)}
            >
              复制
            </Button>
          }
          style={{ marginBottom: 16, background: colors.bgCard, flexShrink: 0, maxHeight: 200, overflow: 'auto' }}
          size="small"
        >
          <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0, fontSize: 13 }}>
            {summary}
          </Paragraph>
        </Card>
      )}

      {/* 问答区域 - 占据剩余空间 */}
      {selectedDocument && (
        <Card
          title={
            <Space>
              <SendOutlined style={{ color: colors.accentPurple }} />
              <span>智能问答</span>
            </Space>
          }
          extra={
            conversation.length > 0 && (
              <Button
                size="small"
                icon={<DeleteOutlined />}
                onClick={handleClearConversation}
              >
                清空对话
              </Button>
            )
          }
          style={{ background: colors.bgCard, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
          bodyStyle={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '12px 16px' }}
          size="small"
        >
          {/* 对话历史 */}
          <div
            style={{
              flex: 1,
              overflow: 'auto',
              marginBottom: 12,
              minHeight: 0,
            }}
          >
            {conversation.length > 0 ? (
              <>
                {conversation.map((msg, index) => (
                  <div
                    key={index}
                    style={{
                      display: 'flex',
                      gap: 12,
                      marginBottom: 16,
                      flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
                    }}
                  >
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: '50%',
                        background: msg.role === 'user' ? colors.accentBlue : colors.accentGreen,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      {msg.role === 'user' ? (
                        <UserOutlined style={{ color: '#fff' }} />
                      ) : (
                        <RobotOutlined style={{ color: '#fff' }} />
                      )}
                    </div>
                    <div
                      style={{
                        maxWidth: '80%',
                        padding: '8px 12px',
                        borderRadius: 8,
                        background: msg.role === 'user' 
                          ? colors.accentBlue + '22'
                          : colors.bgSecondary,
                      }}
                    >
                      <Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                        {msg.content}
                      </Paragraph>
                    </div>
                  </div>
                ))}
                <div ref={conversationEndRef} />
              </>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: colors.textSecondary }}>
                <RobotOutlined style={{ fontSize: 40, marginBottom: 12, opacity: 0.4 }} />
                <div style={{ fontSize: 13 }}>输入问题开始对话</div>
              </div>
            )}
          </div>

          {/* 输入框 */}
          <div style={{ flexShrink: 0 }}>
            <Space.Compact style={{ width: '100%' }}>
              <TextArea
                value={inputQuestion}
                onChange={(e) => setInputQuestion(e.target.value)}
                placeholder="输入关于文档的问题..."
                autoSize={{ minRows: 1, maxRows: 4 }}
                onPressEnter={(e) => {
                  if (!e.shiftKey) {
                    e.preventDefault();
                    handleSendQuestion();
                  }
                }}
                disabled={loading || !isAIConfigured}
              />
              <Button
                type="primary"
                icon={<SendOutlined />}
                onClick={handleSendQuestion}
                loading={loading}
                disabled={!inputQuestion.trim() || !isAIConfigured}
              >
                发送
              </Button>
            </Space.Compact>
            <div style={{ marginTop: 4 }}>
              <Text type="secondary" style={{ fontSize: 11 }}>
                按 Enter 发送，Shift + Enter 换行
              </Text>
            </div>
          </div>
        </Card>
      )}

      {/* 空状态 - 未选择文档时显示 */}
      {!selectedDocument && !loadingDocument && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Empty
            image={<RobotOutlined style={{ fontSize: 64, color: colors.border }} />}
            description={
              <Space direction="vertical">
                <Text type="secondary">选择文档开始使用文档助手</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  支持生成摘要、智能问答等功能
                </Text>
              </Space>
            }
          />
        </div>
      )}
    </div>
  );
};
