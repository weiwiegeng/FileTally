import React, { useState } from 'react';
import {
  Form,
  Input,
  Select,
  Button,
  Space,
  InputNumber,
  Switch,
  message,
  Radio,
  Collapse,
  Typography,
  Row,
  Col,
} from 'antd';
import {
  CloudServerOutlined,
  UserOutlined,
  LockOutlined,
  GlobalOutlined,
  FolderOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useRemoteStore, RemoteConnection } from '../../stores';
import { mapBackendError } from '../../utils/backendError';
import { useThemeColors } from '../../hooks';

const { Text } = Typography;

interface ConnectionFormProps {
  editingConnection?: RemoteConnection;
  onSuccess?: () => void;
  onCancel?: () => void;
}

function suggestName(values: Record<string, unknown>): string {
  const type = String(values.type || 'smb');
  if (type === 'webdav') {
    try {
      const host = new URL(String(values.baseUrl || '')).hostname;
      return host || 'WebDAV';
    } catch {
      return 'WebDAV';
    }
  }
  const host = String(values.host || '').trim();
  const share = String(values.share || '').trim();
  if (type === 'smb' && host && share) return `${host}/${share}`;
  if (host) return host;
  return type.toUpperCase();
}

export const ConnectionForm: React.FC<ConnectionFormProps> = ({
  editingConnection,
  onSuccess,
  onCancel,
}) => {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [form] = Form.useForm();
  const { addConnection, updateConnection } = useRemoteStore();
  const mode = Form.useWatch('mode', form) || editingConnection?.mode || 'direct';
  const type = Form.useWatch('type', form) || editingConnection?.type || 'smb';
  const [advancedOpen, setAdvancedOpen] = useState(
    Boolean(editingConnection && editingConnection.mode === 'system')
  );

  const handleSubmit = async (values: Record<string, unknown>) => {
    try {
      const name = String(values.name || '').trim() || suggestName(values);
      const payload = {
        ...values,
        name,
        host: String(values.host || ''),
        share: String(values.share || ''),
        mode: (values.mode as RemoteConnection['mode']) || 'direct',
      };
      if (editingConnection) {
        updateConnection(editingConnection.id, payload as Partial<RemoteConnection>);
        message.success(t('remote.connectionForm.updateSuccess'));
      } else {
        addConnection(payload as Omit<RemoteConnection, 'id' | 'status'>);
        message.success(t('remote.connectionForm.addSuccess'));
      }
      form.resetFields();
      onSuccess?.();
    } catch (err) {
      message.error(t('remote.connectionForm.saveFailed', { error: mapBackendError(err) }));
    }
  };

  return (
    <Form
      form={form}
      layout="vertical"
      requiredMark="optional"
      initialValues={
        editingConnection || {
          type: 'smb',
          mode: 'direct',
          port: 445,
          rememberPassword: true,
        }
      }
      onFinish={handleSubmit}
      style={{ marginBottom: 0 }}
    >
      <Form.Item
        name="type"
        label={t('remote.connectionForm.labelType')}
        rules={[{ required: true }]}
        style={{ marginBottom: 16 }}
      >
        <Radio.Group
          optionType="button"
          buttonStyle="solid"
          size="middle"
          style={{ width: '100%', display: 'flex' }}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'smb') form.setFieldsValue({ port: 445, mode: 'direct' });
            if (v === 'sftp') form.setFieldsValue({ port: 22, mode: 'direct' });
            if (v === 'webdav') form.setFieldsValue({ mode: 'direct', port: undefined });
          }}
        >
          {(
            [
              ['smb', t('remote.connectionForm.typeSmbShort')],
              ['webdav', t('remote.connectionForm.typeWebdav')],
              ['sftp', t('remote.connectionForm.typeSftp')],
            ] as const
          ).map(([value, label]) => (
            <Radio.Button
              key={value}
              value={value}
              style={{
                flex: 1,
                textAlign: 'center',
                fontWeight: type === value ? 600 : 400,
              }}
            >
              {label}
            </Radio.Button>
          ))}
        </Radio.Group>
      </Form.Item>
      <Text
        type="secondary"
        style={{
          display: 'block',
          fontSize: 12,
          marginTop: -8,
          marginBottom: 16,
          color: colors.textSecondary,
        }}
      >
        {type === 'smb'
          ? t('remote.connectionForm.typeHintSmb')
          : type === 'webdav'
            ? t('remote.connectionForm.typeHintWebdav')
            : t('remote.connectionForm.typeHintSftp')}
      </Text>

      <Form.Item
        name="name"
        label={t('remote.connectionForm.labelName')}
        extra={t('remote.connectionForm.nameOptionalHint')}
        style={{ marginBottom: 16 }}
      >
        <Input
          prefix={<CloudServerOutlined style={{ color: '#8c8c8c' }} />}
          placeholder={t('remote.connectionForm.namePlaceholder')}
          allowClear
        />
      </Form.Item>

      {type === 'webdav' ? (
        <Form.Item
          name="baseUrl"
          label={t('remote.connectionForm.labelWebdavUrl')}
          rules={[{ required: true, message: t('remote.connectionForm.hostRequired') }]}
          style={{ marginBottom: 16 }}
        >
          <Input
            prefix={<GlobalOutlined style={{ color: '#8c8c8c' }} />}
            placeholder={t('remote.connectionForm.webdavUrlPlaceholder')}
          />
        </Form.Item>
      ) : (
        <Form.Item
          label={t('remote.connectionForm.labelHostPort')}
          required
          style={{ marginBottom: 16 }}
        >
          <Space.Compact style={{ width: '100%' }}>
            <Form.Item
              name="host"
              noStyle
              rules={[{ required: true, message: t('remote.connectionForm.hostRequired') }]}
            >
              <Input
                prefix={<GlobalOutlined style={{ color: '#8c8c8c' }} />}
                placeholder={t('remote.connectionForm.hostPlaceholderShort')}
                style={{ width: 'calc(100% - 96px)' }}
              />
            </Form.Item>
            <Form.Item name="port" noStyle>
              <InputNumber
                style={{ width: 96 }}
                placeholder={type === 'sftp' ? '22' : '445'}
                min={1}
                max={65535}
                controls={false}
              />
            </Form.Item>
          </Space.Compact>
        </Form.Item>
      )}

      {type === 'smb' && (
        <Form.Item
          name="share"
          label={t('remote.connectionForm.labelShare')}
          rules={[{ required: true, message: t('remote.connectionForm.shareRequired') }]}
          style={{ marginBottom: 16 }}
        >
          <Input
            prefix={<FolderOutlined style={{ color: '#8c8c8c' }} />}
            placeholder={t('remote.connectionForm.sharePlaceholder')}
          />
        </Form.Item>
      )}

      {type === 'sftp' && (
        <Form.Item
          name="remoteRoot"
          label={t('remote.connectionForm.labelRemoteRoot')}
          style={{ marginBottom: 16 }}
        >
          <Input prefix={<FolderOutlined style={{ color: '#8c8c8c' }} />} placeholder="/" />
        </Form.Item>
      )}

      <Row gutter={12}>
        <Col span={12}>
          <Form.Item
            name="username"
            label={t('remote.connectionForm.labelUsername')}
            rules={
              type !== 'smb' || mode === 'direct'
                ? [{ required: true, message: t('remote.connectionForm.usernameRequired') }]
                : undefined
            }
            style={{ marginBottom: 16 }}
          >
            <Input
              prefix={<UserOutlined style={{ color: '#8c8c8c' }} />}
              placeholder={t('remote.connectionForm.usernameRequiredPlaceholder')}
              autoComplete="username"
            />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item
            name="password"
            label={t('remote.connectionForm.labelPassword')}
            style={{ marginBottom: 16 }}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: '#8c8c8c' }} />}
              placeholder={t('remote.connectionForm.passwordPlaceholderShort')}
              autoComplete="current-password"
            />
          </Form.Item>
        </Col>
      </Row>

      <Collapse
        ghost
        size="small"
        activeKey={advancedOpen ? ['advanced'] : []}
        onChange={(keys) => setAdvancedOpen(keys.includes('advanced'))}
        items={[
          {
            key: 'advanced',
            label: (
              <Text type="secondary" style={{ fontSize: 13 }}>
                {t('remote.connectionForm.advanced')}
              </Text>
            ),
            children: (
              <>
                {type === 'smb' && (
                  <Form.Item
                    name="mode"
                    label={t('remote.connectionForm.labelMode')}
                    rules={[{ required: true }]}
                    extra={t('remote.connectionForm.modeHintShort')}
                    style={{ marginBottom: 12 }}
                  >
                    <Select
                      options={[
                        { value: 'direct', label: t('remote.connectionForm.modeDirect') },
                        { value: 'system', label: t('remote.connectionForm.modeSystem') },
                      ]}
                    />
                  </Form.Item>
                )}
                <Form.Item
                  name="rememberPassword"
                  label={t('remote.connectionForm.rememberPassword')}
                  valuePropName="checked"
                  style={{ marginBottom: 0 }}
                >
                  <Switch />
                </Form.Item>
              </>
            ),
          },
        ]}
        style={{ marginBottom: 16 }}
      />

      <Form.Item style={{ marginBottom: 0, marginTop: 8 }}>
        <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
          {onCancel && (
            <Button onClick={onCancel}>{t('remote.connectionForm.cancel')}</Button>
          )}
          <Button type="primary" htmlType="submit">
            {editingConnection
              ? t('remote.connectionForm.submitSave')
              : t('remote.connectionForm.submitAdd')}
          </Button>
        </Space>
      </Form.Item>
    </Form>
  );
};
