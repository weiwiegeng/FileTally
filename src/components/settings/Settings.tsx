import React, { useState } from 'react';
import {
  Typography,
  Space,
  Card,
  Form,
  Select,
  Switch,
  InputNumber,
  Button,
  Divider,
  Row,
  Col,
  message,
  Popconfirm,
  Tag,
  Input,
  Slider,
} from 'antd';
import {
  SettingOutlined,
  GlobalOutlined,
  FolderOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  RobotOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useSettingsStore, AIProvider } from '../../stores';
import { useThemeColors } from '../../hooks';

const { Title, Text, Paragraph } = Typography;

export const Settings: React.FC = () => {
  const { settings, updateSettings, resetSettings } = useSettingsStore();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'success' | 'error'>('idle');

  const handleReset = () => {
    resetSettings();
    message.success(t('settings.resetSuccess'));
  };

  // AI 模型选项
  const getModelOptions = (provider: AIProvider) => {
    switch (provider) {
      case 'openai':
        return [
          { value: 'gpt-4o', label: 'GPT-4o' },
          { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
          { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
          { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' },
        ];
      case 'claude':
        return [
          { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
          { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus' },
          { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku' },
        ];
      case 'ollama':
        return [
          { value: 'llama3.2', label: 'Llama 3.2' },
          { value: 'qwen2.5', label: 'Qwen 2.5' },
          { value: 'mistral', label: 'Mistral' },
          { value: 'deepseek-coder', label: 'DeepSeek Coder' },
        ];
      default:
        return [];
    }
  };

  // 获取默认 API 端点
  const getDefaultEndpoint = (provider: AIProvider) => {
    switch (provider) {
      case 'openai':
        return 'https://api.openai.com/v1';
      case 'claude':
        return 'https://api.anthropic.com';
      case 'ollama':
        return 'http://localhost:11434';
      default:
        return '';
    }
  };

  // 切换提供商时更新默认配置
  const handleProviderChange = (provider: AIProvider) => {
    const models = getModelOptions(provider);
    updateSettings({
      aiConfig: {
        ...settings.aiConfig,
        provider,
        apiEndpoint: getDefaultEndpoint(provider),
        model: models[0]?.value || '',
      },
    });
    setConnectionStatus('idle');
  };

  // 测试连接
  const testConnection = async () => {
    const { aiConfig } = settings;
    
    if (!aiConfig.apiKey && aiConfig.provider !== 'ollama') {
      message.error('API Key');
      return;
    }

    setTestingConnection(true);
    setConnectionStatus('idle');

    try {
      let response: Response;
      
      if (aiConfig.provider === 'ollama') {
        // Ollama 测试
        response = await fetch(`${aiConfig.apiEndpoint}/api/tags`);
      } else if (aiConfig.provider === 'claude') {
        // Claude 测试
        response = await fetch(`${aiConfig.apiEndpoint}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': aiConfig.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: aiConfig.model,
            max_tokens: 10,
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        });
      } else {
        // OpenAI 兼容测试
        response = await fetch(`${aiConfig.apiEndpoint}/models`, {
          headers: {
            'Authorization': `Bearer ${aiConfig.apiKey}`,
          },
        });
      }

      if (response.ok) {
        setConnectionStatus('success');
        message.success('连接成功');
      } else {
        setConnectionStatus('error');
        message.error(`连接失败: ${response.status}`);
      }
    } catch (error) {
      setConnectionStatus('error');
      message.error('连接失败，请检查网络或配置');
    } finally {
      setTestingConnection(false);
    }
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
          <SettingOutlined style={{ fontSize: 24, color: colors.accentOrange }} />
          <Title level={4} style={{ margin: 0, color: colors.textPrimary }}>
            {t('settings.title')}
          </Title>
        </Space>
        <Popconfirm
          title={t('settings.resetConfirm')}
          description={t('settings.resetDescription')}
          onConfirm={handleReset}
          okText={t('common.confirm')}
          cancelText={t('common.cancel')}
        >
          <Button icon={<ReloadOutlined />}>
            {t('settings.resetSettings')}
          </Button>
        </Popconfirm>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 24px' }}>
        <Row gutter={[16, 16]}>
          {/* 通用设置 */}
          <Col xs={24} lg={12}>
            <Card
              title={
                <Space>
                  <GlobalOutlined style={{ color: '#1890ff' }} />
                  <span>{t('settings.general')}</span>
                </Space>
              }
              size="small"
              style={{ height: '100%' }}
            >
              <Form layout="vertical" size="small">
                <Form.Item label={t('settings.language')}>
                  <Select
                    value={settings.language}
                    onChange={(value) => updateSettings({ language: value })}
                    options={[
                      { value: 'zh-CN', label: '简体中文' },
                      { value: 'en-US', label: 'English' },
                    ]}
                  />
                </Form.Item>

                <Form.Item label={t('settings.theme')}>
                  <Select
                    value={settings.theme}
                    onChange={(value) => updateSettings({ theme: value })}
                    options={[
                      { value: 'dark', label: t('settings.themeDark') },
                      { value: 'light', label: t('settings.themeLight') },
                      { value: 'system', label: t('settings.themeSystem') },
                    ]}
                  />
                </Form.Item>

                <Form.Item label={t('settings.defaultPage')}>
                  <Select
                    value={settings.defaultPage}
                    onChange={(value) => updateSettings({ defaultPage: value })}
                    options={[
                      { value: 'disk', label: t('menu.diskMonitor') },
                      { value: 'browser', label: t('menu.fileBrowser') },
                      { value: 'search', label: t('menu.smartSearch') },
                      { value: 'remote', label: t('menu.remoteConnect') },
                    ]}
                  />
                </Form.Item>
              </Form>
            </Card>
          </Col>

          {/* 文件浏览设置 */}
          <Col xs={24} lg={12}>
            <Card
              title={
                <Space>
                  <FolderOutlined style={{ color: '#52c41a' }} />
                  <span>{t('settings.fileBrowse')}</span>
                </Space>
              }
              size="small"
              style={{ height: '100%' }}
            >
              <Form layout="vertical" size="small">
                <Form.Item label={t('settings.showHiddenFiles')}>
                  <Switch
                    checked={settings.showHiddenFiles}
                    onChange={(checked) => updateSettings({ showHiddenFiles: checked })}
                  />
                </Form.Item>

                <Form.Item label={t('settings.expandLevel')}>
                  <InputNumber
                    min={1}
                    max={10}
                    value={settings.defaultExpandLevel}
                    onChange={(value) => updateSettings({ defaultExpandLevel: value || 2 })}
                    style={{ width: '100%' }}
                  />
                </Form.Item>

                <Form.Item label={t('settings.sortBy')}>
                  <Select
                    value={settings.sortBy}
                    onChange={(value) => updateSettings({ sortBy: value })}
                    options={[
                      { value: 'name', label: t('settings.sortByName') },
                      { value: 'size', label: t('settings.sortBySize') },
                      { value: 'date', label: t('settings.sortByDate') },
                      { value: 'type', label: t('settings.sortByType') },
                    ]}
                  />
                </Form.Item>

                <Form.Item label={t('settings.sortOrder')}>
                  <Select
                    value={settings.sortOrder}
                    onChange={(value) => updateSettings({ sortOrder: value })}
                    options={[
                      { value: 'asc', label: t('settings.sortAsc') },
                      { value: 'desc', label: t('settings.sortDesc') },
                    ]}
                  />
                </Form.Item>
              </Form>
            </Card>
          </Col>

          {/* 搜索设置 */}
          <Col xs={24} lg={12}>
            <Card
              title={
                <Space>
                  <SearchOutlined style={{ color: '#722ed1' }} />
                  <span>{t('settings.searchSettings')}</span>
                </Space>
              }
              size="small"
              style={{ height: '100%' }}
            >
              <Form layout="vertical" size="small">
                <Form.Item label={t('settings.searchContent')}>
                  <Switch
                    checked={settings.defaultSearchContent}
                    onChange={(checked) => updateSettings({ defaultSearchContent: checked })}
                  />
                </Form.Item>

                <Form.Item label={t('settings.searchFilename')}>
                  <Switch
                    checked={settings.defaultSearchFilename}
                    onChange={(checked) => updateSettings({ defaultSearchFilename: checked })}
                  />
                </Form.Item>

                <Form.Item label={t('settings.caseSensitive')}>
                  <Switch
                    checked={settings.defaultCaseSensitive}
                    onChange={(checked) => updateSettings({ defaultCaseSensitive: checked })}
                  />
                </Form.Item>

                <Form.Item 
                  label={t('settings.maxPdfSize')}
                  tooltip={t('settings.maxPdfSizeTooltip')}
                >
                  <InputNumber
                    min={1}
                    max={100}
                    value={settings.maxPdfSizeMB}
                    onChange={(value) => updateSettings({ maxPdfSizeMB: value || 30 })}
                    style={{ width: '100%' }}
                    addonAfter="MB"
                  />
                </Form.Item>

                <Form.Item 
                  label={t('settings.searchTimeout')}
                  tooltip={t('settings.searchTimeoutTooltip')}
                >
                  <InputNumber
                    min={10}
                    max={300}
                    value={settings.searchTimeout}
                    onChange={(value) => updateSettings({ searchTimeout: value || 60 })}
                    style={{ width: '100%' }}
                    addonAfter={t('common.loading').includes('加载') ? '秒' : 's'}
                  />
                </Form.Item>
              </Form>
            </Card>
          </Col>

          {/* 性能设置 */}
          <Col xs={24} lg={12}>
            <Card
              title={
                <Space>
                  <ThunderboltOutlined style={{ color: '#faad14' }} />
                  <span>{t('settings.performance')}</span>
                </Space>
              }
              size="small"
              style={{ height: '100%' }}
            >
              <Form layout="vertical" size="small">
                <Form.Item 
                  label={t('settings.maxConcurrent')}
                  tooltip={t('settings.maxConcurrentTooltip')}
                >
                  <InputNumber
                    min={1}
                    max={16}
                    value={settings.maxConcurrentSearches}
                    onChange={(value) => updateSettings({ maxConcurrentSearches: value || 4 })}
                    style={{ width: '100%' }}
                  />
                </Form.Item>

                <Form.Item label={t('settings.enableCache')}>
                  <Switch
                    checked={settings.enableSearchCache}
                    onChange={(checked) => updateSettings({ enableSearchCache: checked })}
                  />
                  <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                    {t('settings.cacheHint')}
                  </Text>
                </Form.Item>

                <Divider style={{ margin: '16px 0' }} />

                <Form.Item label={t('settings.cacheManagement')}>
                  <Button 
                    onClick={() => {
                      localStorage.removeItem('filetally-search-cache');
                      message.success(t('settings.cacheCleared'));
                    }}
                  >
                    {t('settings.clearCache')}
                  </Button>
                </Form.Item>
              </Form>
            </Card>
          </Col>

          {/* AI 设置 */}
          <Col xs={24}>
            <Card
              title={
                <Space>
                  <RobotOutlined style={{ color: colors.accentPurple }} />
                  <span>AI 配置</span>
                  {connectionStatus === 'success' && (
                    <Tag color="success" icon={<CheckCircleOutlined />}>已连接</Tag>
                  )}
                </Space>
              }
              size="small"
            >
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form layout="vertical" size="small">
                    <Form.Item label="模型提供商">
                      <Select
                        value={settings.aiConfig.provider}
                        onChange={handleProviderChange}
                        options={[
                          { value: 'openai', label: 'OpenAI' },
                          { value: 'claude', label: 'Claude (Anthropic)' },
                          { value: 'ollama', label: 'Ollama (本地)' },
                          { value: 'custom', label: '自定义 API' },
                        ]}
                      />
                    </Form.Item>

                    {settings.aiConfig.provider !== 'ollama' && (
                      <Form.Item label="API Key">
                        <Input.Password
                          value={settings.aiConfig.apiKey}
                          onChange={(e) => updateSettings({
                            aiConfig: { ...settings.aiConfig, apiKey: e.target.value }
                          })}
                          placeholder="sk-xxxxx..."
                        />
                      </Form.Item>
                    )}

                    <Form.Item label="API 地址">
                      <Input
                        value={settings.aiConfig.apiEndpoint}
                        onChange={(e) => updateSettings({
                          aiConfig: { ...settings.aiConfig, apiEndpoint: e.target.value }
                        })}
                        placeholder={getDefaultEndpoint(settings.aiConfig.provider)}
                      />
                    </Form.Item>

                    <Form.Item label="模型">
                      {settings.aiConfig.provider === 'custom' ? (
                        <Input
                          value={settings.aiConfig.model}
                          onChange={(e) => updateSettings({
                            aiConfig: { ...settings.aiConfig, model: e.target.value }
                          })}
                          placeholder="输入模型名称"
                        />
                      ) : (
                        <Select
                          value={settings.aiConfig.model}
                          onChange={(value) => updateSettings({
                            aiConfig: { ...settings.aiConfig, model: value }
                          })}
                          options={getModelOptions(settings.aiConfig.provider)}
                        />
                      )}
                    </Form.Item>
                  </Form>
                </Col>

                <Col xs={24} md={12}>
                  <Form layout="vertical" size="small">
                    <Form.Item label="最大 Token 数">
                      <InputNumber
                        min={256}
                        max={128000}
                        step={256}
                        value={settings.aiConfig.maxTokens}
                        onChange={(value) => updateSettings({
                          aiConfig: { ...settings.aiConfig, maxTokens: value || 4096 }
                        })}
                        style={{ width: '100%' }}
                      />
                    </Form.Item>

                    <Form.Item label={`温度: ${settings.aiConfig.temperature}`}>
                      <Slider
                        min={0}
                        max={2}
                        step={0.1}
                        value={settings.aiConfig.temperature}
                        onChange={(value) => updateSettings({
                          aiConfig: { ...settings.aiConfig, temperature: value }
                        })}
                      />
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        较低的温度产生更确定的输出，较高的温度产生更多样化的输出
                      </Text>
                    </Form.Item>

                    <Divider style={{ margin: '16px 0' }} />

                    <Form.Item>
                      <Button
                        type="primary"
                        icon={testingConnection ? <LoadingOutlined /> : <ApiOutlined />}
                        onClick={testConnection}
                        loading={testingConnection}
                      >
                        测试连接
                      </Button>
                      <Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>
                        {settings.aiConfig.provider === 'ollama'
                          ? '请确保 Ollama 已启动'
                          : '点击测试 API 连接是否正常'}
                      </Text>
                    </Form.Item>
                  </Form>
                </Col>
              </Row>
            </Card>
          </Col>

          {/* 关于 */}
          <Col xs={24}>
            <Card
              title={
                <Space>
                  <InfoCircleOutlined style={{ color: '#13c2c2' }} />
                  <span>{t('settings.about')}</span>
                </Space>
              }
              size="small"
            >
              <Row gutter={24}>
                <Col xs={24} md={12}>
                  <Paragraph>
                    <Text strong style={{ fontSize: 18 }}>FileTally</Text>
                    <Tag color="blue" style={{ marginLeft: 8 }}>v0.1.0</Tag>
                  </Paragraph>
                  <Paragraph type="secondary">
                    {t('settings.description')}
                  </Paragraph>
                  <Paragraph type="secondary" style={{ fontSize: 12 }}>
                    {t('settings.techStack')}
                  </Paragraph>
                </Col>
                <Col xs={24} md={12}>
                  <Space direction="vertical" size="small">
                    <Text type="secondary">{t('settings.features')}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      • {t('settings.featureDisk')}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      • {t('settings.featureBrowse')}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      • {t('settings.featureSearch')}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      • {t('settings.featureRemote')}
                    </Text>
                  </Space>
                </Col>
              </Row>
            </Card>
          </Col>
        </Row>
      </div>
    </div>
  );
};
