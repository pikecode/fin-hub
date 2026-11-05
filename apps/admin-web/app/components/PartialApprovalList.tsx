"use client";
import { Alert, Button, Input, Space, Table, Tag, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { formatMoney } from "@fin-hub/shared-utils";
import { apiClient } from "../lib/api";

interface PartialApproval {
  approval_id: string; approval_no: string; applicant_name?: string; template_name: string;
  approval_status: string; total_amount: string; matched_amount: string; remaining_amount: string;
  confirmed_payment_count: number; sync_conflict_count: number;
}
interface Result { items: PartialApproval[]; total: number; }
const terminal = new Set(["terminated", "canceled", "cancelled", "cancel", "withdrawn", "refuse", "reject", "rejected", "refused", "deny", "撤销", "已撤销"]);

export function PartialApprovalList({ storeId, onContinue }: { storeId: string; onContinue: (approvalNo: string) => void }) {
  const [data, setData] = useState<Result>({ items: [], total: 0 });
  const [draft, setDraft] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef(0);
  async function load() {
    const id = ++request.current;
    setLoading(true);
    try {
      const result = await apiClient.request<Result>(`/api/matches/reconciliation/partial-approvals?${new URLSearchParams({ store_id: storeId, keyword, page: String(page), page_size: "20" })}`);
      if (id === request.current) { setData(result); setError(undefined); }
    } catch (e) { if (id === request.current) setError(e instanceof Error ? e.message : "加载失败"); }
    finally { if (id === request.current) setLoading(false); }
  }
  useEffect(() => {
    void load(); const refresh = () => void load(); window.addEventListener("focus", refresh);
    return () => { ++request.current; window.removeEventListener("focus", refresh); };
  }, [storeId, page, keyword]);
  return <Space direction="vertical" size="middle" style={{ width: "100%" }}>
    <Alert type="info" showIcon message="当前门店全部账期 · 仅列出已确认匹配金额大于 0、但尚未达到审批总额的审批单。候选未确认和已解除匹配不计入；全部匹配后自动移出，解除部分匹配后重新出现。" />
    {error ? <Alert type="error" message={error} /> : null}
    <Space><Input.Search allowClear placeholder="审批单号 / 申请人" value={draft} onChange={e => setDraft(e.target.value)} onSearch={() => { setKeyword(draft.trim()); setPage(1); }} style={{ width: 300 }} /><Button onClick={() => void load()}>刷新</Button><Typography.Text>共 {data.total} 张未匹配满审批单</Typography.Text></Space>
    <Table<PartialApproval> rowKey="approval_id" loading={loading} dataSource={data.items} scroll={{ x: 1050 }} pagination={{ current: page, pageSize: 20, total: data.total, onChange: setPage }} columns={[
      { title: "审批单号", dataIndex: "approval_no" },
      { title: "审批模板", dataIndex: "template_name" },
      { title: "申请人", dataIndex: "applicant_name" },
      { title: "审批总额", dataIndex: "total_amount", align: "right", render: formatMoney },
      { title: "已确认匹配", dataIndex: "matched_amount", align: "right", render: formatMoney },
      { title: "未匹配金额", dataIndex: "remaining_amount", align: "right", render: value => <Typography.Text strong type="warning">{formatMoney(value)}</Typography.Text> },
      { title: "已匹配流水笔数", dataIndex: "confirmed_payment_count" },
      { title: "状态", render: (_, row) => <Space wrap><Tag color="orange">未匹配满</Tag>{terminal.has(row.approval_status.toLowerCase()) ? <Tag color="red">审批已撤销/终止，需核对报表</Tag> : null}{row.sync_conflict_count > 0 ? <Tag color="red">存在来源冲突</Tag> : null}</Space> },
      { title: "操作", render: (_, row) => <Button type="link" disabled={terminal.has(row.approval_status.toLowerCase())} onClick={() => onContinue(row.approval_no)}>继续匹配银行流水</Button> },
    ]} />
  </Space>;
}
