"use client";

import { Alert, Button, Card, DatePicker, Descriptions, Empty, Form, Image, Input, Modal, Select, Space, Spin, Table, Tag, Typography, message } from "antd";
import { EyeOutlined, PaperClipOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import zhCN from "antd/locale/zh_CN";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { BankTransaction, BankTransactionBusinessDetail, Store } from "@fin-hub/shared-types";
import { formatMoney } from "@fin-hub/shared-utils";
import { AppShell } from "../../../components/AppShell";
import { StoreLedgerWorkspaceNav } from "../../../components/StoreLedgerWorkspaceNav";
import { apiClient } from "../../../lib/api";
import { getMyStores } from "../../../lib/referenceData";

const specialLabels: Record<string, string> = {
  current_account: "往来款",
  shareholder_dividend: "股东分红",
  shareholder_capital: "股东注资",
  other_income_expense: "其他收支",
  counter_refund: "对退款",
  loan_repayment: "借还款",
};

function dateText(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD") : "—";
}

function isImageAttachment(attachment: { content_type?: string | null; file_name?: string | null }) {
  return Boolean(
    attachment.content_type?.startsWith("image/")
      || attachment.file_name?.match(/\.(apng|avif|gif|jpe?g|png|webp)$/i),
  );
}

export default function StoreLedgerBankDetailsPage() {
  const params = useParams<{ storeId: string }>();
  const storeId = params.storeId;
  const [store, setStore] = useState<Store | null>(null);
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<BankTransactionBusinessDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [attachmentPreviewUrls, setAttachmentPreviewUrls] = useState<Record<string, string>>({});
  const [filters, setFilters] = useState({ occurred_from: "", occurred_to: "", direction: "", match_status: "", amount: "", counterparty_name: "" });
  const [filterDraft, setFilterDraft] = useState({ occurred_from: "", occurred_to: "", direction: "", match_status: "", amount: "", counterparty_name: "" });

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    setError(null);
    Promise.all([
      getMyStores(),
      apiClient.bankTransactions.list(buildListQuery(storeId, filters)),
    ]).then(([stores, result]) => {
      if (ignore) return;
      setStore(stores.find((item) => item.id === storeId) ?? null);
      setTransactions(result.items);
    }).catch((reason) => {
      if (!ignore) setError(reason instanceof Error ? reason.message : "流水加载失败");
    }).finally(() => {
      if (!ignore) setLoading(false);
    });
    return () => { ignore = true; };
  }, [filters, storeId]);

  function buildListQuery(targetStoreId: string, targetFilters: typeof filters) {
    const query = new URLSearchParams({ store_id: targetStoreId, page_size: "500" });
    if (targetFilters.occurred_from) query.set("occurred_from", targetFilters.occurred_from);
    if (targetFilters.occurred_to) query.set("occurred_to", targetFilters.occurred_to);
    if (targetFilters.direction) query.set("direction", targetFilters.direction);
    if (targetFilters.match_status) query.set("match_status", targetFilters.match_status);
    if (targetFilters.amount) query.set("amount", targetFilters.amount);
    if (targetFilters.counterparty_name.trim()) query.set("counterparty_name", targetFilters.counterparty_name.trim());
    return `?${query.toString()}`;
  }

  function submitFilters() {
    setFilters(filterDraft);
  }

  function resetFilters() {
    const empty = { occurred_from: "", occurred_to: "", direction: "", match_status: "", amount: "", counterparty_name: "" };
    setFilterDraft(empty);
    setFilters(empty);
  }

  async function openDetail(transaction: BankTransaction) {
    setDetailLoading(true);
    try {
      const nextDetail = await apiClient.bankTransactions.businessDetail(transaction.id);
      setDetail(nextDetail);
      const imageAttachments = nextDetail.expenses.flatMap((item) => item.attachments).filter(isImageAttachment);
      const previewEntries = await Promise.all(imageAttachments.map(async (attachment) => {
        try {
          const data = await apiClient.attachments.accessUrl(attachment.id);
          return [attachment.id, data.url] as const;
        } catch {
          return [attachment.id, ""] as const;
        }
      }));
      setAttachmentPreviewUrls((current) => ({
        ...current,
        ...Object.fromEntries(previewEntries.filter(([, url]) => url)),
      }));
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "业务详情加载失败");
    } finally {
      setDetailLoading(false);
    }
  }

  async function openAttachment(id: string) {
    try {
      const blob = await apiClient.attachments.download(id);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "凭证打开失败");
    }
  }

  const columns = useMemo<ColumnsType<BankTransaction>>(() => [
    { title: "发生日期", dataIndex: "occurred_at", width: 130, render: dateText },
    { title: "类型", dataIndex: "direction", width: 90, render: (value: string) => <Tag color={value === "income" ? "green" : "red"}>{value === "income" ? "收入" : "支出"}</Tag> },
    { title: "金额", dataIndex: "amount", width: 140, align: "right", render: (value: string) => <Typography.Text strong>{formatMoney(value)}</Typography.Text> },
    { title: "对方户名", dataIndex: "counterparty_name", render: (value: string | null) => value || "—" },
    { title: "流水备注", dataIndex: "summary", ellipsis: true, render: (value: string | null) => value || "—" },
    { title: "流水属性", dataIndex: "special_type", width: 110, render: (value: string | null) => value ? <Tag color="orange">{specialLabels[value] ?? value}</Tag> : <Tag>普通流水</Tag> },
    { title: "关联状态", width: 100, render: (_: unknown, record) => record.special_type || Number(record.matched_amount) > 0 ? <Tag color="green">已关联</Tag> : <Tag>未关联</Tag> },
    { title: "操作", width: 100, render: (_: unknown, record) => <Button type="link" onClick={() => void openDetail(record)}>查看业务</Button> },
  ], []);

  const current = detail?.transaction;
  return <AppShell title="流水业务详情" kicker="查看银行流水对应的审批报销、营业收入和特殊业务">
    {store ? <StoreLedgerWorkspaceNav storeId={storeId} storeName={store.name} activeKey="bankDetails" /> : <Card loading />}
    {error ? <Alert type="error" showIcon message="流水加载失败" description={error} /> : null}
    <Card title="银行流水业务明细" extra={<Typography.Text type="secondary">点击流水查看业务发生情况</Typography.Text>}>
      <Form layout="inline" style={{ marginBottom: 16 }} onFinish={submitFilters}>
        <Form.Item label="发生日期"><DatePicker.RangePicker locale={zhCN.DatePicker} format="YYYY年MM月DD日" value={filterDraft.occurred_from ? [dayjs(filterDraft.occurred_from), dayjs(filterDraft.occurred_to).subtract(1, "day")] : null} onChange={(values) => setFilterDraft((current) => ({ ...current, occurred_from: values?.[0]?.format("YYYY-MM-DD") ?? "", occurred_to: values?.[1]?.add(1, "day").format("YYYY-MM-DD") ?? "" }))} /></Form.Item>
        <Form.Item label="类型"><Select allowClear placeholder="全部类型" value={filterDraft.direction || undefined} onChange={(value) => setFilterDraft((current) => ({ ...current, direction: value ?? "" }))} options={[{ label: "收入", value: "income" }, { label: "支出", value: "expense" }]} style={{ width: 110 }} /></Form.Item>
        <Form.Item label="关联状态"><Select allowClear placeholder="全部状态" value={filterDraft.match_status || undefined} onChange={(value) => setFilterDraft((current) => ({ ...current, match_status: value ?? "" }))} options={[{ label: "未关联", value: "unmatched" }, { label: "已关联", value: "matched" }]} style={{ width: 120 }} /></Form.Item>
        <Form.Item label="金额"><Input inputMode="decimal" placeholder="精确金额" value={filterDraft.amount} onChange={(event) => setFilterDraft((current) => ({ ...current, amount: event.target.value }))} style={{ width: 130 }} /></Form.Item>
        <Form.Item label="户名"><Input placeholder="对方户名" value={filterDraft.counterparty_name} onChange={(event) => setFilterDraft((current) => ({ ...current, counterparty_name: event.target.value }))} style={{ width: 150 }} /></Form.Item>
        <Form.Item><Space><Button type="primary" htmlType="submit">查询</Button><Button onClick={resetFilters}>重置</Button></Space></Form.Item>
      </Form>
      <Table rowKey="id" loading={loading} columns={columns} dataSource={transactions} pagination={false} scroll={{ x: 1100 }} onRow={(record) => ({ onClick: () => void openDetail(record), style: { cursor: "pointer" } })} locale={{ emptyText: "暂无银行流水" }} />
    </Card>
    <Modal open={Boolean(detail)} onCancel={() => setDetail(null)} footer={null} width={980} title="银行流水业务详情">
      {detailLoading ? <Spin /> : null}
      {current ? <>
        <Descriptions bordered size="small" column={3} style={{ marginBottom: 20 }}>
          <Descriptions.Item label="发生日期">{dateText(current.occurred_at)}</Descriptions.Item>
          <Descriptions.Item label="流水类型">{current.direction === "income" ? "收入" : "支出"}</Descriptions.Item>
          <Descriptions.Item label="金额"><Typography.Text strong type={current.direction === "income" ? "success" : "danger"}>{formatMoney(current.amount)}</Typography.Text></Descriptions.Item>
          <Descriptions.Item label="对方户名">{current.counterparty_name || "—"}</Descriptions.Item>
          <Descriptions.Item label="流水属性">{detail.special_label || "普通流水"}</Descriptions.Item>
          <Descriptions.Item label="备注">{detail.remark || "—"}</Descriptions.Item>
        </Descriptions>
        {detail.expenses.length ? <Card size="small" title="关联审批报销" style={{ marginBottom: 16 }}>
          <Table
            size="small"
            rowKey="expense_item_id"
            pagination={false}
            scroll={{ x: 900 }}
            dataSource={detail.expenses}
            columns={[
              { title: "费用内容", dataIndex: "description", width: 220, render: (value: string, item) => <Space direction="vertical" size={2}><Typography.Text strong>{value}</Typography.Text><Typography.Text type="secondary">{item.template_name || "审批单"} · {item.approval_no || "无审批单号"}</Typography.Text></Space> },
              { title: "费用分类", width: 180, render: (_: unknown, item) => item.category_l1 ? <Space direction="vertical" size={2}><Typography.Text>{item.category_l1}</Typography.Text>{item.category_l2 ? <Typography.Text type="secondary">{item.category_l2}</Typography.Text> : null}</Space> : <Typography.Text type="secondary">未分类</Typography.Text> },
              { title: "费用日期", dataIndex: "expense_date", width: 110, render: dateText },
              { title: "申请人", width: 110, render: (_: unknown, item) => item.applicant_name || "—" },
              { title: "完成日期", width: 110, render: (_: unknown, item) => dateText(item.approved_at) },
              { title: "匹配金额", dataIndex: "amount", width: 120, align: "right", render: (value: string) => <Typography.Text strong type="danger">{formatMoney(value)}</Typography.Text> },
              { title: "凭证", width: 150, render: (_: unknown, item) => item.attachments.length ? <Space wrap size={[6, 6]}>
                <Image.PreviewGroup>
                  {item.attachments.filter(isImageAttachment).map((attachment) => {
                    const sourceUrl = attachmentPreviewUrls[attachment.id];
                    return sourceUrl ? <Image key={attachment.id} src={sourceUrl} alt={attachment.file_name || "报销凭证"} width={48} height={60} preview={{ mask: <EyeOutlined /> }} style={{ objectFit: "cover", borderRadius: 5, border: "1px solid #d9d9d9" }} /> : null;
                  })}
                </Image.PreviewGroup>
                {item.attachments.filter((attachment) => !isImageAttachment(attachment)).map((attachment) => <Button key={attachment.id} type="link" size="small" icon={<PaperClipOutlined />} onClick={() => void openAttachment(attachment.id)}>打开文件</Button>)}
              </Space> : <Typography.Text type="secondary">无</Typography.Text> },
            ]}
          />
        </Card> : null}
        {detail.revenues.length ? <Card size="small" title="关联营业收入" style={{ marginBottom: 16 }}>
          {detail.revenues.map((item) => <Card.Grid key={item.match_id} style={{ width: "100%" }}><Space direction="vertical"><Typography.Text strong>{item.channel}</Typography.Text><Typography.Text>收入日期：{dateText(item.revenue_start_date)}{item.revenue_start_date !== item.revenue_end_date ? ` 至 ${dateText(item.revenue_end_date)}` : ""}</Typography.Text><Typography.Text>匹配金额：{formatMoney(item.amount)}</Typography.Text>{item.records.length ? <Typography.Text type="secondary">明细日期：{item.records.map((record) => `${dateText(record.revenue_date)}（${formatMoney(record.net_amount)}）`).join("、")}</Typography.Text> : null}</Space></Card.Grid>)}
        </Card> : null}
        {!detail.expenses.length && !detail.revenues.length ? <Empty description={detail.special_label ? `特殊流水：${detail.special_label}，请查看备注` : "暂未关联审批报销或营业收入"} /> : null}
      </> : null}
    </Modal>
  </AppShell>;
}
