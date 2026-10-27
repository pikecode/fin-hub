"use client";

import { Alert, Button, Card, Checkbox, Form, Input, Modal, Space, Spin, Statistic, Table, Tabs, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useRef, useState } from "react";
import type { BankTransaction, BankPaymentSettlementDetail, BankPaymentSettlementList, BankPaymentSettlementCandidate } from "@fin-hub/shared-types";
import { apiClient } from "../lib/api";
import { MoneyDisplay } from "./MoneyDisplay";

export function UnpaidPaymentSettlement({ storeId, onChanged }: { storeId?: string; onChanged: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("pending");
  const [page, setPage] = useState(1);
  const [summary, setSummary] = useState<BankPaymentSettlementList>();
  const [list, setList] = useState<BankPaymentSettlementList>();
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<BankPaymentSettlementDetail>();
  const [candidates, setCandidates] = useState<BankPaymentSettlementCandidate[]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmedDifference, setConfirmedDifference] = useState(false);
  const [reasonForm] = Form.useForm<{ remark: string }>();
  const detailRequest = useRef(0);
  const listRequest = useRef(0);
  const summaryRequest = useRef(0);

  async function refreshSummary() {
    if (!storeId) return;
    const request = ++summaryRequest.current;
    try {
      const result = await apiClient.bankPaymentSettlements.list(storeId, "pending", 1, 1);
      if (request === summaryRequest.current) setSummary(result);
    } catch (error) {
      if (request === summaryRequest.current) message.error(error instanceof Error ? error.message : "未实付汇总加载失败");
    }
  }
  async function refreshList() {
    if (!storeId) return;
    const request = ++listRequest.current;
    setLoading(true); setList(undefined);
    try {
      const result = await apiClient.bankPaymentSettlements.list(storeId, status, page);
      if (request === listRequest.current) setList(result);
    } catch (error) {
      if (request === listRequest.current) message.error(error instanceof Error ? error.message : "核对列表加载失败");
    } finally { if (request === listRequest.current) setLoading(false); }
  }
  useEffect(() => {
    ++detailRequest.current; ++listRequest.current; ++summaryRequest.current;
    setOpen(false); setDetailOpen(false); setDetail(undefined); setSummary(undefined); setList(undefined); setPage(1);
    void refreshSummary();
  }, [storeId]);
  useEffect(() => { if (open) void refreshList(); }, [open, status, page, storeId]);

  async function loadDetail(id: string, nameSearch = "") {
    const request = ++detailRequest.current;
    setDetailOpen(true); setDetailLoading(true); setDetail(undefined); setSelection([]);
    try {
      const result = await apiClient.bankPaymentSettlements.detail(id);
      const choices = result.status === "open" ? await apiClient.bankPaymentSettlements.candidates(id, nameSearch) : [];
      if (request !== detailRequest.current) return;
      setDetail(result); setCandidates(choices);
    } catch (error) {
      if (request === detailRequest.current) message.error(error instanceof Error ? error.message : "核对明细加载失败");
    } finally { if (request === detailRequest.current) setDetailLoading(false); }
  }
  async function mutate(action: () => Promise<unknown>, completed = false) {
    if (!detail || busy) return;
    const id = detail.source.id;
    setBusy(true);
    try {
      await action();
      message.success(completed ? "实付核对已完成，原未实付登记已作废保留" : "关联已更新");
      if (completed) setConfirmOpen(false);
      await loadDetail(id, search);
      await Promise.all([refreshList(), refreshSummary(), Promise.resolve(onChanged())]);
    } catch (error) { message.error(error instanceof Error ? error.message : "核对操作失败"); }
    finally { setBusy(false); }
  }
  const columns: ColumnsType<BankTransaction> = [
    { title: "发生日期", dataIndex: "occurred_at", width: 115, render: (v: string) => v.slice(0, 10) },
    { title: "对方户名", dataIndex: "counterparty_name", render: (v) => v || "—" },
    { title: "金额", dataIndex: "amount", width: 150, align: "right", render: (v) => <MoneyDisplay value={Number(v)} /> },
    { title: "备注", dataIndex: "summary", ellipsis: true, render: (v) => v || "—" },
  ];
  const difference = Number(detail?.difference || 0);
  return (
    <>
      <Card size="small">
        <Space size={24} wrap style={{ width: "100%", justifyContent: "space-between" }}>
          <Space direction="vertical" size={2}>
            <Typography.Text strong>未实付核对</Typography.Text>
            <Typography.Text type="secondary">当前门店全部月份 · 未实付不计入银行余额</Typography.Text>
          </Space>
          <Space size={24} wrap>
            <Statistic title="待核对笔数" value={summary?.total ?? 0} />
            <Statistic title="未实付登记总额" value={Number(summary?.registered_total || 0)} precision={2} prefix="¥" />
            <Statistic title="已关联实付合计" value={Number(summary?.linked_total || 0)} precision={2} prefix="¥" />
            <Button type="primary" disabled={!storeId} onClick={() => { setPage(1); setOpen(true); }}>进入核对</Button>
          </Space>
        </Space>
      </Card>
      <Modal title="未实付核对" open={open} width={1100} footer={null} onCancel={() => setOpen(false)}>
        <Tabs activeKey={status} onChange={(key) => { setStatus(key); setPage(1); }} items={[{ key: "pending", label: "待核对" }, { key: "completed", label: "已完成记录" }]} />
        <Table rowKey="id" loading={loading} dataSource={list?.items || []} columns={[...columns, {
          title: "操作", width: 110, render: (_, bank) => <Button type="link" onClick={() => { setSearch(""); void loadDetail(bank.id); }}>{status === "completed" ? "查看记录" : "核对付款"}</Button>,
        }]} pagination={{ current: page, pageSize: 12, total: list?.total || 0, showSizeChanger: false, onChange: setPage, showTotal: (n) => `共 ${n} 笔` }} scroll={{ x: 800 }} />
      </Modal>
      <Modal title={detail?.status === "completed" ? "实付核对记录" : "关联实际付款"} open={detailOpen} width={1100} maskClosable={false} closable={!busy} keyboard={!busy}
        onCancel={() => { if (!busy) { ++detailRequest.current; setDetailOpen(false); } }}
        footer={detail?.status === "open" ? <Button type="primary" loading={busy} disabled={!detail.links.length || detailLoading} onClick={() => { reasonForm.resetFields(); setConfirmedDifference(false); setConfirmOpen(true); }}>确认核对完成</Button> : null}>
        <Spin spinning={detailLoading}>
          {detail && <Space direction="vertical" size={16} style={{ display: "flex" }}>
            <Typography.Text>{detail.source.occurred_at.slice(0, 10)} · {detail.source.counterparty_name || "未填写户名"} · {detail.source.summary || "未填写备注"}</Typography.Text>
            <Space size={40} wrap>
              <Statistic title="原登记金额" value={Number(detail.registered_amount)} precision={2} prefix="¥" />
              <Statistic title="已关联实付" value={Number(detail.actual_amount)} precision={2} prefix="¥" />
              <Statistic title="差额（实付－登记）" value={difference} precision={2} prefix="¥" />
            </Space>
            {detail.status === "completed" ? <Alert type="success" showIcon message="已核对完成，原登记作废保留，审批费用金额和入账月份不变" description={detail.remark || "金额一致"} /> :
              <Alert type="info" showIcon message="添加关联仅保存核对进度；全部关联后请点击确认核对完成。差额不代表应付余额。" />}
            <Typography.Text strong>已关联实际付款（{detail.links.length} 笔）</Typography.Text>
            <Table<BankTransaction> rowKey="id" size="small" pagination={false} dataSource={detail.links.map((link) => link.transaction)}
              columns={[...columns, ...(detail.status === "open" ? [{ title: "操作", width: 80, render: (_: unknown, bank: BankTransaction) => <Button type="link" danger disabled={busy} onClick={() => { const link = detail.links.find((item) => item.transaction.id === bank.id); if (link) void mutate(() => apiClient.bankPaymentSettlements.remove(detail.source.id, link.id)); }}>移除</Button> }] : [])]} scroll={{ x: 700 }} />
            {detail.status === "open" && <>
              <Space wrap style={{ justifyContent: "space-between" }}>
                <Typography.Text strong>推荐实付流水</Typography.Text>
                <Space><Input.Search value={search} onChange={(e) => setSearch(e.target.value)} placeholder="按对方户名查询" allowClear onSearch={() => void loadDetail(detail.source.id, search)} style={{ width: 240 }} disabled={busy} />
                  <Button loading={busy} disabled={!selection.length} onClick={() => void mutate(() => apiClient.bankPaymentSettlements.add(detail.source.id, selection))}>关联已选 {selection.length} 笔</Button></Space>
              </Space>
              <Table rowKey={(item) => item.transaction.id} size="small" dataSource={candidates} pagination={{ pageSize: 8, showSizeChanger: false }}
                rowSelection={{ selectedRowKeys: selection, onChange: (keys) => setSelection(keys.map(String)), getCheckboxProps: () => ({ disabled: busy }) }}
                columns={[
                  { title: "推荐度", width: 90, render: (_, item) => <Tag color={item.score >= 60 ? "green" : "default"}>{item.score}</Tag> },
                  { title: "日期", render: (_, item) => item.transaction.occurred_at.slice(0, 10) },
                  { title: "对方户名", render: (_, item) => item.transaction.counterparty_name || "—" },
                  { title: "实付金额", align: "right", render: (_, item) => <MoneyDisplay value={Number(item.transaction.amount)} /> },
                  { title: "备注", render: (_, item) => item.transaction.summary || "—" },
                ]} scroll={{ x: 700 }} />
            </>}
          </Space>}
        </Spin>
      </Modal>
      <Modal title="确认完成实付核对" open={confirmOpen} confirmLoading={busy} maskClosable={false} closable={!busy} keyboard={!busy} onCancel={() => { if (!busy) setConfirmOpen(false); }}
        onOk={async () => {
          if (!detail || busy) return;
          try {
            const values = await reasonForm.validateFields();
            if (difference !== 0 && !confirmedDifference) { message.warning("请确认金额差异"); return; }
            await mutate(() => apiClient.bankPaymentSettlements.complete(detail.source.id, values.remark || "", confirmedDifference), true);
          } catch { /* Form displays field validation errors. */ }
        }} okText="确认完成">
        <Typography.Paragraph>登记金额 ¥{Number(detail?.registered_amount || 0).toFixed(2)}，实付合计 ¥{Number(detail?.actual_amount || 0).toFixed(2)}，差额 ¥{difference.toFixed(2)}。</Typography.Paragraph>
        <Typography.Paragraph type="secondary">完成后保留原登记及审批对账依据，真实付款承接业务关联；不增加或分摊审批费用。</Typography.Paragraph>
        <Form form={reasonForm} layout="vertical"><Form.Item name="remark" label={difference !== 0 ? "差额原因" : "核对备注"} rules={difference !== 0 ? [{ required: true, whitespace: true, message: "请填写差额原因" }] : []}><Input.TextArea rows={3} maxLength={1000} /></Form.Item></Form>
        {difference !== 0 && <Checkbox checked={confirmedDifference} onChange={(e) => setConfirmedDifference(e.target.checked)}>我已核对金额差异，确认按上述实付金额完成</Checkbox>}
      </Modal>
    </>
  );
}
