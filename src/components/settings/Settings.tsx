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
  AutoComplete,
} from 'antd';
import {
  SettingOutlined,
  GlobalOutlined,
  FolderOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  DownloadOutlined,
  RobotOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore, AIProvider, AICapability } from '../../stores';
import { useThemeColors } from '../../hooks';
import {
  AI_PROVIDER_PRESETS,
  getDefaultEndpoint,
  getModelOptions,
  getProviderProtocol,
  inferCapability,
} from '../../services/aiProviders';

const { Title, Text, Paragraph } = Typography;

export const Settings: React.FC = () => {
  const { settings, updateSettings, resetSettings } = useSettingsStore();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);

  const handleExportDiagnostics = async () => {
    setExportingDiagnostics(true);
    try {
      const json = await invoke<string>('export_diagnostics');
      await navigator.clipboard.writeText(json);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `filetally-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      message.success(t('settings.diagnosticsExported'));
    } catch (err) {
      console.error('export diagnostics failed:', err);
      message.error(t('settings.diagnosticsExportFailed'));
    } finally {
      setExportingDiagnostics(false);
    }
  };

  const handleReset = () => {
    resetSettings();
    message.success(t('settings.resetSuccess'));
  };

  const providerOptions = AI_PROVIDER_PRESETS.map((p) => ({
    value: p.id,
    label: p.labelKey ? t(p.labelKey) : p.label || p.id,
  }));

  // 切换提供商时更新默认配置
  const handleProviderChange = (provider: AIProvider) => {
    const models = getModelOptions(provider);
    const model = models[0]?.value || settings.aiConfig.model || '';
    updateSettings({
      aiConfig: {
        ...settings.aiConfig,
        provider,
        apiEndpoint: getDefaultEndpoint(provider),
        model,
        capability: inferCapability(provider, model),
      },
    });
    setConnectionStatus('idle');
  };

  const handleModelChange = (model: string) => {
    updateSettings({
      aiConfig: {
        ...settings.aiConfig,
        model,
        capability: inferCapability(settings.aiConfig.provider, model, settings.aiConfig.capability),
      },
    });
  };

  // 测试连接
  const testConnection = async () => {
    const { aiConfig } = settings;
    const protocol = getProviderProtocol(aiConfig.provider);
    
    if (!aiConfig.apiKey && protocol !== 'ollama') {
      message.error(t('settings.apiKeyRequired'));
      return;
    }

    setTestingConnection(true);
    setConnectionStatus('idle');

    try {
      let response: Response;
      
      if (protocol === 'ollama') {
        response = await fetch(`${aiConfig.apiEndpoint}/api/tags`);
      } else if (protocol === 'claude') {
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
        // OpenAI-compatible: prefer a tiny chat call (some CN APIs lack /models)
        const endpoint = aiConfig.apiEndpoint.replace(/\/$/, '');
        response = await fetch(`${endpoint}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${aiConfig.apiKey}`,
          },
          body: JSON.stringify({
            model: aiConfig.model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 5,
          }),
        });
      }

      if (response.ok) {
        setConnectionStatus('success');
        message.success(t('settings.testSuccess'));
      } else {
        setConnectionStatus('error');
        message.error(t('settings.testFailedStatus', { status: response.status }));
      }
    } catch (error) {
      setConnectionStatus('error');
      message.error(t('settings.testFailedNetwork'));
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
                      { value: 'zh-CN', label: t('settings.languageZhCN') },
                      { value: 'en-US', label: t('settings.languageEnUS') },
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
                      { value: 'filter', label: t('menu.smartSearch') },
                      { value: 'remote', label: t('menu.remoteConnect') },
                      { value: 'transfer', label: t('menu.fileTransfer') },
                      { value: 'excel', label: t('menu.excelCheck') },
                      { value: 'ai', label: t('menu.aiAnalysis') },
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
                    onChange={(value) => updateSettings({ defaultExpandLevel: value || 1 })}
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
                      { value: 'modified_time', label: t('settings.sortByDate') },
                      { value: 'extension', label: t('settings.sortByType') },
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

                <Form.Item label={t('settings.previewPanelPosition')}>
                  <Select
                    value={settings.previewPanelPosition}
                    onChange={(value) => updateSettings({ previewPanelPosition: value })}
                    options={[
                      { value: 'right', label: t('settings.previewRight') },
                      { value: 'bottom', label: t('settings.previewBottom') },
                    ]}
                  />
                </Form.Item>

                <Form.Item
                  label={t('settings.dualPaneBrowser')}
                  extra={t('settings.dualPaneBrowserHint')}
                >
                  <Switch
                    checked={settings.dualPaneBrowser}
                    onChange={(checked) => updateSettings({ dualPaneBrowser: checked })}
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
                    addonAfter={t('settings.unitMB')}
                  />
                </Form.Item>

                <Form.Item
                  label={t('settings.maxTextReadLabel')}
                  tooltip={t('settings.maxTextReadTooltip')}
                >
                  <InputNumber
                    min={1}
                    max={100}
                    value={settings.maxTextSizeMB}
                    onChange={(value) => updateSettings({ maxTextSizeMB: value || 10 })}
                    style={{ width: '100%' }}
                    addonAfter={t('settings.unitMB')}
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
                    addonAfter={t('settings.secondsSuffix')}
                  />
                </Form.Item>

                <Form.Item>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('settings.searchIndexLocalOnly')}
                  </Text>
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

                <Form.Item label={t('settings.transferBandwidth')}>
                  <InputNumber
                    min={0}
                    max={1024}
                    value={settings.transferBandwidthMBps}
                    onChange={(value) => {
                      const mbps = value || 0;
                      updateSettings({ transferBandwidthMBps: mbps });
                      void invoke('set_transfer_bandwidth_limit', {
                        bytesPerSec: Math.round(mbps * 1024 * 1024),
                      }).catch(() => undefined);
                    }}
                    style={{ width: '100%' }}
                  />
                </Form.Item>

                <Form.Item label={t('settings.transferConcurrency')}>
                  <InputNumber
                    min={1}
                    max={8}
                    value={settings.transferConcurrency}
                    onChange={(value) => {
                      const max = value || 1;
                      updateSettings({ transferConcurrency: max });
                      void invoke('set_transfer_concurrency', { max }).catch(() => undefined);
                    }}
                    style={{ width: '100%' }}
                  />
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
                  <span>{t('settings.aiSectionTitle')}</span>
                  {connectionStatus === 'success' && (
                    <Tag color="success" icon={<CheckCircleOutlined />}>{t('settings.aiConnected')}</Tag>
                  )}
                </Space>
              }
              size="small"
            >
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form layout="vertical" size="small">
                    <Form.Item label={t('settings.modelProvider')}>
                      <Select
                        value={settings.aiConfig.provider}
                        onChange={handleProviderChange}
                        options={providerOptions}
                        showSearch
                        optionFilterProp="label"
                      />
                    </Form.Item>

                    {getProviderProtocol(settings.aiConfig.provider) !== 'ollama' && (
                      <Form.Item label={t('settings.apiKeyLabel')}>
                        <Input.Password
                          value={settings.aiConfig.apiKey}
                          onChange={(e) => updateSettings({
                            aiConfig: { ...settings.aiConfig, apiKey: e.target.value }
                          })}
                          placeholder={t('settings.apiKeyPlaceholder')}
                        />
                      </Form.Item>
                    )}

                    <Form.Item
                      label={t('settings.apiEndpoint')}
                      extra={t('settings.apiEndpointHint')}
                    >
                      <Input
                        value={settings.aiConfig.apiEndpoint}
                        onChange={(e) => updateSettings({
                          aiConfig: { ...settings.aiConfig, apiEndpoint: e.target.value }
                        })}
                        placeholder={getDefaultEndpoint(settings.aiConfig.provider)}
                      />
                    </Form.Item>

                    <Form.Item
                      label={t('settings.model')}
                      extra={t('settings.modelHint')}
                    >
                      <AutoComplete
                        value={settings.aiConfig.model}
                        options={getModelOptions(settings.aiConfig.provider).map((m) => ({
                          value: m.value,
                          label: (
                            <Space>
                              <span>{m.label}</span>
                              {m.capability && m.capability !== 'text' && (
                                <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                                  {t(`settings.capability.${m.capability}`)}
                                </Tag>
                              )}
                            </Space>
                          ),
                        }))}
                        onChange={handleModelChange}
                        placeholder={t('settings.modelPlaceholder')}
                        filterOption={(input, option) =>
                          String(option?.value || '')
                            .toLowerCase()
                            .includes(input.toLowerCase())
                        }
                      />
                    </Form.Item>

                    <Form.Item
                      label={t('settings.capabilityLabel')}
                      extra={t('settings.capabilityHint')}
                    >
                      <Select<AICapability>
                        value={settings.aiConfig.capability || 'text'}
                        onChange={(capability) =>
                          updateSettings({
                            aiConfig: { ...settings.aiConfig, capability },
                          })
                        }
                        options={[
                          { value: 'text', label: t('settings.capability.text') },
                          { value: 'vision', label: t('settings.capability.vision') },
                          { value: 'multimodal', label: t('settings.capability.multimodal') },
                        ]}
                      />
                    </Form.Item>
                  </Form>
                </Col>

                <Col xs={24} md={12}>
                  <Form layout="vertical" size="small">
                    <Form.Item label={t('settings.maxTokens')}>
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

                    <Form.Item label={t('settings.temperatureLabel', { value: settings.aiConfig.temperature })}>
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
                        {t('settings.temperatureHint')}
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
                        {t('settings.testConnection')}
                      </Button>
                      <Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>
                        {getProviderProtocol(settings.aiConfig.provider) === 'ollama'
                          ? t('settings.testHintOllama')
                          : t('settings.testHintApi')}
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
                  <Button
                    icon={<DownloadOutlined />}
                    loading={exportingDiagnostics}
                    onClick={() => void handleExportDiagnostics()}
                  >
                    {t('settings.exportDiagnostics')}
                  </Button>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('settings.diagnosticsExportHint')}
                  </Text>
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
