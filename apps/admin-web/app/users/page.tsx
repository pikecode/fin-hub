"use client";

import { Alert, Button, Card, Checkbox, Form, Input, Modal, Popconfirm, Radio, Select, Space, Table, Tabs, Tag, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useMemo, useState } from "react";
import type {
  PermissionKey,
  RoleCreate,
  RoleRead,
  RoleUpdate,
  Store,
  StoreGroup,
  UserAccount,
} from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";

type CheckboxValue = string | number | boolean;

interface UserFormValues {
  username: string;
  display_name: string;
  password?: string;
  role: string;
  store_ids: string[];
  store_group_ids: string[];
}

type StoreScopeMode = "all" | "group" | "store" | "mixed";

const permissionGroups: { title: string; options: { label: string; value: PermissionKey }[] }[] = [
  { title: "工作台", options: [{ label: "查看工作台", value: "dashboard.view" }] },
  {
    title: "财务对账",
    options: [
      { label: "查看对账", value: "reconciliation.view" },
      { label: "维护对账", value: "reconciliation.manage" },
      { label: "查看报表", value: "reports.view" },
      { label: "查看收入", value: "revenue.view" },
      { label: "维护收入", value: "revenue.manage" },
    ],
  },
  {
    title: "钉钉同步",
    options: [
      { label: "查看钉钉数据", value: "dingtalk.view" },
      { label: "维护同步配置", value: "dingtalk.manage" },
    ],
  },
  {
    title: "基础资料",
    options: [
      { label: "查看门店", value: "stores.view" },
      { label: "维护门店", value: "stores.manage" },
      { label: "查看分类", value: "categories.view" },
      { label: "维护分类", value: "categories.manage" },
    ],
  },
  {
    title: "系统管理",
    options: [
      { label: "查看用户", value: "users.view" },
      { label: "维护用户", value: "users.manage" },
      { label: "查看审计", value: "audit.view" },
      { label: "系统设置", value: "settings.manage" },
    ],
  },
];

const impliedPermissions: Partial<Record<PermissionKey, PermissionKey[]>> = {
  "reconciliation.view": ["stores.view", "categories.view", "dingtalk.view"],
  "reconciliation.manage": ["reconciliation.view"],
  "dingtalk.manage": ["dingtalk.view"],
  "revenue.manage": ["revenue.view", "stores.view"],
  "stores.manage": ["stores.view"],
  "categories.manage": ["categories.view"],
  "users.manage": ["users.view"],
};

function normalizePermissions(permissions: Iterable<PermissionKey>) {
  const normalized = new Set(permissions);
  Array.from(normalized).forEach((permission) => {
    impliedPermissions[permission]?.forEach((implied) => normalized.add(implied));
  });
  return Array.from(normalized);
}

function PermissionMatrix({
  value = [],
  onChange,
}: {
  value?: PermissionKey[];
  onChange?: (permissions: PermissionKey[]) => void;
}) {
  function updateGroup(groupOptions: { value: PermissionKey }[], checkedValues: CheckboxValue[]) {
    const next = new Set(value);
    groupOptions.forEach((option) => next.delete(option.value));
    checkedValues.forEach((checkedValue) => next.add(checkedValue as PermissionKey));
    onChange?.(normalizePermissions(next));
  }

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      {permissionGroups.map((group) => (
        <Card key={group.title} size="small" title={group.title}>
          <Checkbox.Group
            value={value.filter((permission) => group.options.some((option) => option.value === permission))}
            options={group.options}
            onChange={(checkedValues) => updateGroup(group.options, checkedValues)}
          />
        </Card>
      ))}
    </Space>
  );
}

function roleLabel(role: string, roles: RoleRead[]) {
  return roles.find((item) => item.key === role)?.name ?? role;
}

function roleMeta(role: string, roles: RoleRead[]) {
  return roles.find((item) => item.key === role);
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [storeGroups, setStoreGroups] = useState<StoreGroup[]>([]);
  const [roles, setRoles] = useState<RoleRead[]>([]);
  const [rolePermissions, setRolePermissions] = useState<Record<string, PermissionKey[]>>({});
  const [selectedRoleKey, setSelectedRoleKey] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSavingRole, setIsSavingRole] = useState(false);
  const [isRoleModalOpen, setIsRoleModalOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<RoleRead | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSubmittingUser, setIsSubmittingUser] = useState(false);
  const [editingUser, setEditingUser] = useState<UserAccount | null>(null);
  const [storeScopeMode, setStoreScopeMode] = useState<StoreScopeMode>("group");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<UserFormValues>();
  const [roleForm] = Form.useForm<RoleCreate | RoleUpdate>();
  const watchedRole = Form.useWatch("role", form);
  const watchedStoreIds = Form.useWatch("store_ids", form) ?? [];
  const watchedStoreGroupIds = Form.useWatch("store_group_ids", form) ?? [];
  const allStoreIds = useMemo(() => stores.map((store) => store.id), [stores]);

  const roleOptions = useMemo(() => roles.map((role) => ({ label: role.name, value: role.key })), [roles]);

  const selectedRole = useMemo(
    () => roles.find((role) => role.key === selectedRoleKey) ?? roles[0] ?? null,
    [roles, selectedRoleKey],
  );
  const selectedRoleIsAdmin = selectedRole?.is_admin ?? false;
  const watchedRoleIsAdmin = roleMeta(watchedRole ?? "", roles)?.is_admin ?? false;
  function inferScopeMode(storeIds: string[], storeGroupIds: string[], roleKey: string): StoreScopeMode {
    if (roleMeta(roleKey, roles)?.is_admin) {
      return "all";
    }
    if (storeIds.length > 0 && storeGroupIds.length > 0) {
      return "mixed";
    }
    if (storeGroupIds.length > 0) {
      return "group";
    }
    if (storeIds.length === allStoreIds.length && allStoreIds.length > 0) {
      return "all";
    }
    if (storeIds.length > 0) {
      return "store";
    }
    return "group";
  }

  async function loadData() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [userPage, storePage, storeGroupPage, roleList, rolePermissionList] = await Promise.all([
        apiClient.users.list("?page_size=200"),
        apiClient.stores.list("?page_size=500"),
        apiClient.stores.listGroups(),
        apiClient.roles.list(),
        apiClient.roles.listPermissions(),
      ]);
      setUsers(userPage.items);
      setStores(storePage.items);
      setStoreGroups(storeGroupPage);
      setRoles(roleList);
      const nextRolePermissions: Record<string, PermissionKey[]> = {};
      rolePermissionList.forEach((item) => {
        nextRolePermissions[item.role] = item.permissions;
      });
      roleList.forEach((role) => {
        nextRolePermissions[role.key] = nextRolePermissions[role.key] ?? role.permissions;
      });
      setRolePermissions(nextRolePermissions);
      setSelectedRoleKey((current) => current || roleList[0]?.key || "");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载数据");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, []);

  async function saveRolePermissions() {
    if (!selectedRole || selectedRoleIsAdmin) {
      return;
    }
    setIsSavingRole(true);
    setErrorMessage(null);
    try {
      await apiClient.roles.updatePermissions(selectedRole.key, {
        permissions: rolePermissions[selectedRole.key] ?? [],
      });
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法保存角色权限");
    } finally {
      setIsSavingRole(false);
    }
  }

  function openCreateRoleModal() {
    setEditingRole(null);
    roleForm.resetFields();
    roleForm.setFieldsValue({ key: "", name: "", sort_order: 0 });
    setIsRoleModalOpen(true);
  }

  function openEditRoleModal(role: RoleRead) {
    setEditingRole(role);
    roleForm.setFieldsValue({ name: role.name, sort_order: role.sort_order });
    setIsRoleModalOpen(true);
  }

  async function submitRole(values: RoleCreate | RoleUpdate) {
    setIsSavingRole(true);
    try {
      if (editingRole) {
        await apiClient.roles.update(editingRole.key, values as RoleUpdate);
      } else {
        await apiClient.roles.create(values as RoleCreate);
      }
      setIsRoleModalOpen(false);
      setEditingRole(null);
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法保存角色");
    } finally {
      setIsSavingRole(false);
    }
  }

  async function deleteRole(role: RoleRead) {
    setIsSavingRole(true);
    try {
      await apiClient.roles.delete(role.key);
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法删除角色");
    } finally {
      setIsSavingRole(false);
    }
  }

  function openCreateUserModal() {
    setEditingUser(null);
    form.resetFields();
    const defaultRole = roles[0]?.key ?? "";
    setStoreScopeMode(inferScopeMode([], [], defaultRole));
    form.setFieldsValue({ role: defaultRole, store_ids: [], store_group_ids: [] });
    setIsModalOpen(true);
  }

  function openEditUserModal(user: UserAccount) {
    setEditingUser(user);
    setStoreScopeMode(inferScopeMode(user.store_ids, user.store_group_ids, user.role));
    form.setFieldsValue({
      username: user.username,
      display_name: user.display_name,
      role: user.role,
      password: "",
      store_ids: user.store_ids,
      store_group_ids: user.store_group_ids,
    });
    setIsModalOpen(true);
  }

  function applyScopeMode(mode: StoreScopeMode, roleKey: string) {
    setStoreScopeMode(mode);
    if (roleMeta(roleKey, roles)?.is_admin) {
      form.setFieldsValue({ store_ids: [], store_group_ids: [] });
      return;
    }
    if (mode === "all") {
      form.setFieldsValue({ store_ids: allStoreIds, store_group_ids: [] });
      return;
    }
    if (mode === "group") {
      form.setFieldsValue({ store_ids: [], store_group_ids: watchedStoreGroupIds });
      return;
    }
    if (mode === "store") {
      form.setFieldsValue({ store_ids: watchedStoreIds, store_group_ids: [] });
      return;
    }
    form.setFieldsValue({ store_ids: watchedStoreIds, store_group_ids: watchedStoreGroupIds });
  }

  async function submitUser(values: UserFormValues) {
    setIsSubmittingUser(true);
    setErrorMessage(null);
    try {
      const isAdminRole = roleMeta(values.role, roles)?.is_admin ?? false;
      const storeIds = isAdminRole ? [] : (values.store_ids.length === allStoreIds.length && values.store_group_ids.length === 0 ? allStoreIds : values.store_ids);
      const storeGroupIds = isAdminRole ? [] : values.store_group_ids;
      const payload = {
        display_name: values.display_name,
        role: values.role,
        password: values.password || undefined,
        store_ids: storeIds,
        store_group_ids: storeGroupIds,
      };
      if (editingUser) {
        await apiClient.users.update(editingUser.id, payload);
      } else {
        await apiClient.users.create({
          username: values.username,
          display_name: values.display_name,
          password: values.password ?? "",
          role: values.role,
          store_ids: storeIds,
          store_group_ids: storeGroupIds,
        });
      }
      setIsModalOpen(false);
      setEditingUser(null);
      form.resetFields();
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法保存用户");
    } finally {
      setIsSubmittingUser(false);
    }
  }

  const columns: ColumnsType<UserAccount> = [
    { title: "账号", dataIndex: "username" },
    { title: "姓名", dataIndex: "display_name" },
    { title: "角色", dataIndex: "role", render: (value: string) => roleLabel(value, roles) },
    {
      title: "门店范围",
      dataIndex: "store_ids",
      render: (_, record) =>
        roleMeta(record.role, roles)?.is_admin || (record.store_ids.length === stores.length && record.store_group_ids.length === 0 && stores.length > 0) ? (
          <Tag color="green">全部门店</Tag>
        ) : (
          <Space size={4} wrap>
            <Tag>{record.store_ids.length} 家门店</Tag>
            <Tag color="blue">{record.store_group_ids.length} 个分组</Tag>
          </Space>
        ),
    },
    {
      title: "状态",
      dataIndex: "status",
      render: (value: UserAccount["status"]) => (value === "active" ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
    },
    {
      title: "操作",
      width: 170,
      render: (_, record) => (
        <Space>
          <Button type="link" onClick={() => openEditUserModal(record)}>编辑</Button>
        </Space>
      ),
    },
  ];

  const roleColumns: ColumnsType<RoleRead> = [
    { title: "角色键", dataIndex: "key" },
    { title: "角色名称", dataIndex: "name" },
    { title: "权限数", dataIndex: "permissions", render: (value: PermissionKey[]) => <Tag>{value.length} 项</Tag> },
    {
      title: "系统角色",
      dataIndex: "is_system",
      render: (value: boolean) => (value ? <Tag color="green">是</Tag> : <Tag>否</Tag>),
    },
    {
      title: "操作",
      width: 180,
      render: (_, record) => (
        <Space>
          <Button type="link" onClick={() => openEditRoleModal(record)}>编辑</Button>
          <Popconfirm
            title={`删除角色 ${record.name}？`}
            description="如果已有用户使用该角色，不能删除。"
            okButtonProps={{ danger: true }}
            onConfirm={() => deleteRole(record)}
          >
            <Button type="link" danger disabled={record.is_system}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <AppShell title="用户管理" action={<Button type="primary" onClick={openCreateUserModal}>新增用户</Button>}>
      {errorMessage ? <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon /> : null}
      <Space direction="vertical" size={16} style={{ width: "100%", display: "flex" }}>
        <Card
          title="角色管理"
          extra={
            <Space>
              <Button onClick={openCreateRoleModal}>新增角色</Button>
              <Button type="primary" onClick={saveRolePermissions} loading={isSavingRole} disabled={!selectedRole || selectedRoleIsAdmin}>
                保存角色权限
              </Button>
            </Space>
          }
        >
          <Table rowKey="id" size="small" pagination={false} columns={roleColumns} dataSource={roles} />
          <div style={{ marginTop: 16 }}>
            <Select
              value={selectedRoleKey || undefined}
              onChange={setSelectedRoleKey}
              options={roles.map((role) => ({ label: role.name, value: role.key }))}
              style={{ width: 260, marginBottom: 12 }}
              placeholder="选择角色"
            />
            {selectedRole ? (
              <Alert
                type={selectedRoleIsAdmin ? "warning" : "info"}
                showIcon
                message={selectedRoleIsAdmin ? "管理员权限固定" : `正在编辑：${selectedRole.name}`}
                description={selectedRoleIsAdmin ? "管理员拥有全部权限。" : "这里修改后会直接影响拥有该角色的用户。"}
              />
            ) : null}
            {selectedRole && !selectedRoleIsAdmin ? (
              <div style={{ marginTop: 12 }}>
                <PermissionMatrix
                  value={rolePermissions[selectedRole.key] ?? []}
                  onChange={(permissions) => setRolePermissions((current) => ({ ...current, [selectedRole.key]: permissions }))}
                />
              </div>
            ) : null}
          </div>
        </Card>

        <Card title="用户列表">
          <Table rowKey="id" loading={isLoading} columns={columns} dataSource={users} />
        </Card>
      </Space>

      <Modal
        title={editingRole ? "编辑角色" : "新增角色"}
        open={isRoleModalOpen}
        onCancel={() => {
          setIsRoleModalOpen(false);
          setEditingRole(null);
        }}
        onOk={() => roleForm.submit()}
        confirmLoading={isSavingRole}
      >
        <Form form={roleForm} layout="vertical" onFinish={submitRole}>
          {!editingRole ? <Form.Item name="key" label="角色键" rules={[{ required: true }]}><Input placeholder="例如：ops" /></Form.Item> : null}
          <Form.Item name="name" label="角色名称" rules={[{ required: true }]}><Input placeholder="例如：运营" /></Form.Item>
          <Form.Item name="sort_order" label="排序"><Input type="number" /></Form.Item>
        </Form>
      </Modal>

      <Modal
        title={editingUser ? "编辑用户" : "新增用户"}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          setEditingUser(null);
        }}
        onOk={() => form.submit()}
        confirmLoading={isSubmittingUser}
        width={720}
      >
        <Form form={form} layout="vertical" onFinish={submitUser}>
          <Form.Item name="username" label="账号" rules={[{ required: !editingUser }]}>
            <Input disabled={Boolean(editingUser)} />
          </Form.Item>
          <Form.Item name="display_name" label="姓名" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select
              options={roleOptions}
              onChange={(roleKey) => {
                const nextMode = inferScopeMode(form.getFieldValue("store_ids") ?? [], form.getFieldValue("store_group_ids") ?? [], roleKey);
                setStoreScopeMode(nextMode);
                if (roleMeta(roleKey, roles)?.is_admin) {
                  form.setFieldsValue({ store_ids: [], store_group_ids: [] });
                }
              }}
            />
          </Form.Item>
          <Form.Item name="password" label={editingUser ? "新密码" : "密码"} rules={[{ required: !editingUser, min: 8 }]}>
            <Input.Password />
          </Form.Item>
          <Alert type="info" showIcon style={{ marginBottom: 16 }} message="门店范围是数据范围，不是功能权限" />
          {watchedRoleIsAdmin ? (
            <Alert type="success" showIcon message="管理员拥有全部门店，无需单独设置范围。" />
          ) : (
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Form.Item label="门店范围模式">
                <Radio.Group
                  value={storeScopeMode}
                  onChange={(event) => applyScopeMode(event.target.value as StoreScopeMode, watchedRole ?? roles[0]?.key ?? "")}
                  optionType="button"
                  buttonStyle="solid"
                  options={[
                    { label: "全部门店", value: "all" },
                    { label: "按分组", value: "group" },
                    { label: "按门店", value: "store" },
                    { label: "混合", value: "mixed" },
                  ]}
                />
              </Form.Item>
              {(storeScopeMode === "group" || storeScopeMode === "mixed") ? (
                <Form.Item name="store_group_ids" label="可管理分组">
                  <Select
                    mode="multiple"
                    showSearch
                    allowClear
                    optionFilterProp="label"
                    options={storeGroups.map((group) => ({ label: group.name, value: group.id }))}
                  />
                </Form.Item>
              ) : null}
              {(storeScopeMode === "store" || storeScopeMode === "mixed") ? (
                <Form.Item name="store_ids" label="可管理门店">
                  <Select
                    mode="multiple"
                    showSearch
                    allowClear
                    optionFilterProp="label"
                    options={stores.map((store) => ({ label: store.name, value: store.id }))}
                  />
                </Form.Item>
              ) : null}
              {storeScopeMode === "all" ? (
                <Alert
                  type="success"
                  showIcon
                  message={`当前已覆盖全部门店，共 ${allStoreIds.length} 家`}
                />
              ) : null}
            </Space>
          )}
        </Form>
      </Modal>
    </AppShell>
  );
}
