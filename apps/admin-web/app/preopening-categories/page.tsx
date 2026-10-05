"use client";
import { useEffect, useState } from "react";
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  message,
} from "antd";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";
export interface PreopeningCategory {
  id: string;
  name: string;
  parent_id: string | null;
  status: string;
  sort_order: number;
}
export default function PreopeningCategoriesPage() {
  const [items, setItems] = useState<PreopeningCategory[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<
    PreopeningCategory | null | undefined
  >();
  const [form] = Form.useForm();
  const [deleteTarget, setDeleteTarget] = useState<PreopeningCategory | null>(
    null,
  );
  async function load() {
    setLoading(true);
    try {
      setItems(
        await apiClient.request<PreopeningCategory[]>(
          "/api/preopening/categories",
        ),
      );
    } catch (e) {
      message.error(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const roots = items.filter((c) => !c.parent_id);
  const rows = roots.map((c) => ({
    ...c,
    children: items.filter((x) => x.parent_id === c.id).length
      ? items.filter((x) => x.parent_id === c.id)
      : undefined,
  }));
  function edit(c: PreopeningCategory | null) {
    setEditing(c);
    form.setFieldsValue(
      c ?? { name: "", parent_id: null, status: "active", sort_order: 0 },
    );
  }
  async function save() {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    setLoading(true);
    try {
      await apiClient.request(
        `/api/preopening/categories${editing ? `/${editing.id}` : ""}`,
        { method: editing ? "PATCH" : "POST", body: JSON.stringify(values) },
      );
      setEditing(undefined);
      message.success("分类已保存");
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setLoading(false);
    }
  }
  return (
    <AppShell title="筹建费用分类">
      <Card
        title="筹建费用分类"
        extra={
          <Button type="primary" onClick={() => edit(null)}>
            新增分类
          </Button>
        }
      >
        <Table
          rowKey="id"
          loading={loading}
          dataSource={rows}
          pagination={false}
          columns={[
            { title: "分类名称", dataIndex: "name" },
            {
              title: "状态",
              render: (_, c) => (
                <Tag color={c.status === "active" ? "green" : "default"}>
                  {c.status === "active" ? "启用" : "停用"}
                </Tag>
              ),
            },
            {
              title: "操作",
              render: (_, c) => (
                <Space>
                  <Button type="link" onClick={() => edit(c)}>
                    编辑
                  </Button>
                  <Button type="link" danger onClick={() => setDeleteTarget(c)}>
                    删除
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>
      <Modal
        title={editing ? "编辑筹建分类" : "新增筹建分类"}
        open={editing !== undefined}
        onCancel={() => setEditing(undefined)}
        onOk={() => void save()}
        confirmLoading={loading}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="分类名称"
            rules={[
              { required: true, whitespace: true, message: "请输入分类名称" },
            ]}
          >
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item name="parent_id" label="上级分类">
            <Select
              allowClear
              placeholder="不选为一级分类"
              options={roots
                .filter((c) => c.status === "active" && c.id !== editing?.id)
                .map((c) => ({ label: c.name, value: c.id }))}
            />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select
              options={[
                { label: "启用", value: "active" },
                { label: "停用", value: "inactive" },
              ]}
            />
          </Form.Item>
          <Form.Item name="sort_order" label="排序">
            <InputNumber min={0} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={`删除「${deleteTarget?.name ?? ""}」？`}
        open={!!deleteTarget}
        onCancel={() => {
          if (!loading) setDeleteTarget(null);
        }}
        confirmLoading={loading}
        onOk={async () => {
          if (!deleteTarget) return;
          setLoading(true);
          try {
            await apiClient.request(
              `/api/preopening/categories/${deleteTarget.id}`,
              { method: "DELETE" },
            );
            setDeleteTarget(null);
            message.success("分类已删除");
            await load();
          } catch (e) {
            message.error(e instanceof Error ? e.message : "删除失败");
          } finally {
            setLoading(false);
          }
        }}
      >
        已被引用或有子分类的分类不能删除。
      </Modal>
    </AppShell>
  );
}
