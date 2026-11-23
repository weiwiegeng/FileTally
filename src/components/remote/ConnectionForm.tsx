import React from 'react';
import { Form, Input, Select, Button, Space, InputNumber, message } from 'antd';
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

interface ConnectionFormProps {
  editingConnection?: RemoteConnection;
  onSuccess?: () => void;
  onCancel?: () => void;
}

export const ConnectionForm: React.FC<ConnectionFormProps> = ({
  editingConnection,
  onSuccess,
  onCancel,
}) => {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const { addConnection, updateConnection } = useRemoteStore();
  const mode = Form.useWatch('mode', form) || editingConnection?.mode || 'direct';

  const handleSubmit = async (values: any) => {
    try {
      if (editingConnection) {
        updateConnection(editingConnection.id, values);
        message.success(t('remote.connectionForm.updateSuccess'));
      } else {
        addConnection(values);
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
      initialValues={editingConnection || {
        type: 'smb',
        mode: 'direct',
        port: 445,
      }}
      onFinish={handleSubmit}
      style={{ maxWidth: 500 }}
    >
      <Form.Item
        name="name"
        label={t('remote.connectionForm.labelName')}
        rules={[{ required: true, message: t('remote.connectionForm.nameRequired') }]}
      >
        <Input
          prefix={<CloudServerOutlined style={{ color: '#8c8c8c' }} />}
          placeholder={t('remote.connectionForm.namePlaceholder')}
        />
      </Form.Item>

      <Form.Item
        name="type"
        label={t('remote.connectionForm.labelType')}
        rules={[{ required: true }]}
      >
        <Select
          options={[
            { value: 'smb', label: t('remote.connectionForm.typeSmb') },
          ]}
        />
      </Form.Item>

      <Form.Item
        name="mode"
        label={t('remote.connectionForm.labelMode')}
        rules={[{ required: true }]}
        extra={t('remote.connectionForm.modeHint')}
      >
        <Select
          options={[
            { value: 'direct', label: t('remote.connectionForm.modeDirect') },
            { value: 'system', label: t('remote.connectionForm.modeSystem') },
          ]}
        />
      </Form.Item>

      <Form.Item
        name="host"
        label={t('remote.connectionForm.labelHost')}
        rules={[{ required: true, message: t('remote.connectionForm.hostRequired') }]}
      >
        <Input
          prefix={<GlobalOutlined style={{ color: '#8c8c8c' }} />}
          placeholder={t('remote.connectionForm.hostPlaceholder')}
        />
      </Form.Item>

      <Form.Item
        name="port"
        label={t('remote.connectionForm.labelPort')}
      >
        <InputNumber
          style={{ width: '100%' }}
          placeholder={t('remote.connectionForm.portPlaceholder')}
        />
      </Form.Item>

      <Form.Item
        name="share"
        label={t('remote.connectionForm.labelShare')}
        rules={[{ required: true, message: t('remote.connectionForm.shareRequired') }]}
      >
        <Input
          prefix={<FolderOutlined style={{ color: '#8c8c8c' }} />}
          placeholder={t('remote.connectionForm.sharePlaceholder')}
        />
      </Form.Item>

      <Form.Item
        name="username"
        label={t('remote.connectionForm.labelUsername')}
        rules={
          mode === 'direct'
            ? [{ required: true, message: t('remote.connectionForm.usernameRequired') }]
            : undefined
        }
      >
        <Input
          prefix={<UserOutlined style={{ color: '#8c8c8c' }} />}
          placeholder={
            mode === 'direct'
              ? t('remote.connectionForm.usernameRequiredPlaceholder')
              : t('remote.connectionForm.usernamePlaceholder')
          }
        />
      </Form.Item>

      <Form.Item
        name="password"
        label={t('remote.connectionForm.labelPassword')}
      >
        <Input.Password
          prefix={<LockOutlined style={{ color: '#8c8c8c' }} />}
          placeholder={t('remote.connectionForm.passwordPlaceholder')}
        />
      </Form.Item>

      <Form.Item>
        <Space>
          <Button type="primary" htmlType="submit">
            {editingConnection ? t('remote.connectionForm.submitSave') : t('remote.connectionForm.submitAdd')}
          </Button>
          {onCancel && (
            <Button onClick={onCancel}>{t('remote.connectionForm.cancel')}</Button>
          )}
        </Space>
      </Form.Item>
    </Form>
  );
};
