import React from 'react';
import { Form, Input, Select, Button, Space, InputNumber, message } from 'antd';
import {
  CloudServerOutlined,
  UserOutlined,
  LockOutlined,
  GlobalOutlined,
  FolderOutlined,
} from '@ant-design/icons';
import { useRemoteStore, RemoteConnection } from '../../stores';

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
  const [form] = Form.useForm();
  const { addConnection, updateConnection } = useRemoteStore();

  const handleSubmit = async (values: any) => {
    try {
      if (editingConnection) {
        updateConnection(editingConnection.id, values);
        message.success('连接配置已更新');
      } else {
        addConnection(values);
        message.success('连接已添加');
      }
      form.resetFields();
      onSuccess?.();
    } catch (err) {
      message.error('保存失败: ' + String(err));
    }
  };

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={editingConnection || {
        type: 'smb',
        port: 445,
      }}
      onFinish={handleSubmit}
      style={{ maxWidth: 500 }}
    >
      <Form.Item
        name="name"
        label="连接名称"
        rules={[{ required: true, message: '请输入连接名称' }]}
      >
        <Input
          prefix={<CloudServerOutlined style={{ color: '#8c8c8c' }} />}
          placeholder="例如: 公司NAS"
        />
      </Form.Item>

      <Form.Item
        name="type"
        label="连接类型"
        rules={[{ required: true }]}
      >
        <Select
          options={[
            { value: 'smb', label: 'SMB/CIFS (Windows共享/NAS)' },
            { value: 'nfs', label: 'NFS (Linux/Unix)' },
            { value: 'ftp', label: 'FTP/SFTP' },
          ]}
        />
      </Form.Item>

      <Form.Item
        name="host"
        label="主机地址"
        rules={[{ required: true, message: '请输入主机地址' }]}
      >
        <Input
          prefix={<GlobalOutlined style={{ color: '#8c8c8c' }} />}
          placeholder="IP地址或主机名，例如: 192.168.1.100"
        />
      </Form.Item>

      <Form.Item
        name="port"
        label="端口"
      >
        <InputNumber
          style={{ width: '100%' }}
          placeholder="默认: SMB=445, FTP=21"
        />
      </Form.Item>

      <Form.Item
        name="share"
        label="共享名称"
        rules={[{ required: true, message: '请输入共享名称' }]}
      >
        <Input
          prefix={<FolderOutlined style={{ color: '#8c8c8c' }} />}
          placeholder="共享文件夹名称"
        />
      </Form.Item>

      <Form.Item
        name="username"
        label="用户名"
      >
        <Input
          prefix={<UserOutlined style={{ color: '#8c8c8c' }} />}
          placeholder="可选，留空则使用访客登录"
        />
      </Form.Item>

      <Form.Item
        name="password"
        label="密码"
      >
        <Input.Password
          prefix={<LockOutlined style={{ color: '#8c8c8c' }} />}
          placeholder="可选"
        />
      </Form.Item>

      <Form.Item>
        <Space>
          <Button type="primary" htmlType="submit">
            {editingConnection ? '保存修改' : '添加连接'}
          </Button>
          {onCancel && (
            <Button onClick={onCancel}>取消</Button>
          )}
        </Space>
      </Form.Item>
    </Form>
  );
};
