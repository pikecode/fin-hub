"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  Alert,
  Button,
  Card,
  Cascader,
  DatePicker,
  Col,
  Empty,
  Pagination,
  Row,
  Spin,
  Tooltip,
  Form,
  Image,
  Input,
  InputNumber,
  Modal,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import type { Attachment, BankTransaction } from "@fin-hub/shared-types";
import { AppShell } from "../../../components/AppShell";
import { StoreLedgerWorkspaceNav } from "../../../components/StoreLedgerWorkspaceNav";
import { apiClient } from "../../../lib/api";
import zhCN from "antd/es/date-picker/locale/zh_CN";
import { formatMoney } from "@fin-hub/shared-utils";
import type { PreopeningCategory } from "../../../preopening-categories/page";
interface Item {
  id: string;
  description: string;
  amount: string;
  category_id: string | null;
  category_l1: string | null;
  category_l2: string | null;
  voucher_count: number;
  approval_no?: string;
  submit_time?: string;
}
interface Approval {
  score?: string;
  reason?: string;
  id: string;
  approval_no: string;
  amount: string;
  submit_time: string;
  finish_time: string;
  items: Item[];
}
interface Match {
  counterparty_name?: string;
  occurred_at?: string;
  id: string;
  amount: string;
  approval_id: string;
  bank_transaction_id: string;
  confirmed_at: string;
}
interface Workspace {
  store_name: string;
  status: string;
  closed_at: string | null;
  total: string;
  details: Item[];
  approvals: Approval[];
  matches: Match[];
}
function Voucher({ itemId, count }: { itemId: string; count: number }) {
  const [attachments, setAttachments] = useState<Attachment[]>([]),
    [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const blobs: string[] = [];
    (async () => {
      try {
        const page = await apiClient.attachments.list(
          `?resource_type=expense_item&resource_id=${itemId}&page_size=100`,
        );
        const entries = await Promise.all(
          page.items.map(async (a) => {
            if (a.source === "dingtalk")
              return [
                a.id,
                (await apiClient.attachments.accessUrl(a.id)).url,
              ] as const;
            const blob = await apiClient.attachments.download(a.id);
            if (blob.type.startsWith("image/")) a.content_type = blob.type;
            const url = URL.createObjectURL(blob);
            blobs.push(url);
            return [a.id, url] as const;
          }),
        );
        if (!disposed) {
          setAttachments(page.items);
          setUrls(Object.fromEntries(entries));
        }
      } catch (e) {
        if (!disposed)
          setError(e instanceof Error ? e.message : "凭证加载失败");
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
      blobs.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [itemId]);
  if (!count) return <>无</>;
  if (loading)
    return <Typography.Text type="secondary">加载中…</Typography.Text>;
  if (error) return <Typography.Text type="danger">{error}</Typography.Text>;
  return (
    <Image.PreviewGroup>
      <Space wrap>
        {attachments.map((a) =>
          a.content_type?.startsWith("image/") ||
          /\.(png|jpe?g|gif|webp)(?:[?#].*)?$/i.test(a.file_name) ||
          /\.(png|jpe?g|gif|webp)(?:[?#].*)?$/i.test(urls[a.id]) ? (
            <Image
              key={a.id}
              src={urls[a.id]}
              width={56}
              height={72}
              style={{ objectFit: "cover", borderRadius: 4 }}
              alt="报销凭证"
            />
          ) : (
            <Button
              key={a.id}
              size="small"
              href={urls[a.id]}
              target="_blank"
              rel="noreferrer"
            >
              {a.file_name}
            </Button>
          ),
        )}
      </Space>
    </Image.PreviewGroup>
  );
}
export default function PreopeningPage() {
  const { storeId } = useParams<{ storeId: string }>();
  const [data, setData] = useState<Workspace | null>(null),
    [categories, setCategories] = useState<PreopeningCategory[]>([]),
    [banks, setBanks] = useState<BankTransaction[]>([]);
  const [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [bank, setBank] = useState<BankTransaction | null>(null),
    [approval, setApproval] = useState<Approval | null>(null),
    [selected, setSelected] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<Item[] | null>(null),
    [detailTitle, setDetailTitle] = useState("");
  const [candidates, setCandidates] = useState<Approval[]>([]),
    [candidateLoading, setCandidateLoading] = useState(false),
    [approvalSearch, setApprovalSearch] = useState("");
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [candidatePage, setCandidatePage] = useState(1);
  const [confirmAction, setConfirmAction] = useState<Match | "close" | null>(
    null,
  );
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [bankPage, setBankPage] = useState(1),
    [bankTotal, setBankTotal] = useState(0);
  const generation = useRef(0);
  const [filterForm] = Form.useForm();
  const [form] = Form.useForm();
  async function load() {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        store_id: storeId,
        page: String(bankPage),
        page_size: "20",
        direction: "expense",
        match_status: "unmatched",
        exclude_special: "true",
        ...filters,
      });
      const [workspace, cs, bs] = await Promise.all([
        apiClient.request<Workspace>(`/api/preopening/stores/${storeId}`),
        apiClient.request<PreopeningCategory[]>("/api/preopening/categories"),
        apiClient.bankTransactions.list(`?${query}`),
      ]);
      if (current !== generation.current) return;
      setData(workspace);
      setCategories(cs);
      setBanks(bs.items);
      setBankTotal(bs.total);
    } catch (e) {
      if (current === generation.current)
        setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    setData(null);
    setBank(null);
    setApproval(null);
    setIsConfirmOpen(false);
    setBankPage(1);
    filterForm.resetFields();
    setFilters({});
  }, [storeId]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [storeId, bankPage, filters]);
  useEffect(() => {
    if (!bank) return;
    let ignore = false;
    setCandidateLoading(true);
    setCandidates([]);
    setApprovalSearch("");
    setCandidatePage(1);
    apiClient
      .request<Approval[]>(
        `/api/preopening/stores/${storeId}/candidates?bank_transaction_id=${bank.id}`,
      )
      .then((items) => {
        if (!ignore) setCandidates(items);
      })
      .catch((e) => {
        if (!ignore)
          message.error(e instanceof Error ? e.message : "候选加载失败");
      })
      .finally(() => {
        if (!ignore) setCandidateLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [bank?.id, storeId]);
  const closed = data?.status === "closed";
  const options = categories
    .filter((c) => !c.parent_id && c.status === "active")
    .map((c) => ({
      label: c.name,
      value: c.id,
      children: categories
        .filter((x) => x.parent_id === c.id && x.status === "active")
        .map((x) => ({ label: x.name, value: x.id })),
    }))
    .filter((c) => c.children.length);
  const categoryRows = useMemo(() => {
    const roots = new Map<
      string,
      {
        key: string;
        name: string;
        amount: number;
        children: { key: string; name: string; amount: number }[];
      }
    >();
    for (const item of data?.details ?? []) {
      const root = item.category_l1 ?? "未分类",
        child = item.category_l2 ?? "未分类";
      if (!roots.has(root))
        roots.set(root, { key: root, name: root, amount: 0, children: [] });
      const r = roots.get(root)!;
      r.amount += Number(item.amount);
      let c = r.children.find((c) => c.name === child);
      if (!c) {
        c = { key: `${root}/${child}`, name: child, amount: 0 };
        r.children.push(c);
      }
      c.amount += Number(item.amount);
    }
    return [...roots.values()];
  }, [data]);
  const bankRows = banks.filter(
    (b) =>
      b.direction === "expense" &&
      !b.special_type &&
      Number(b.matched_amount ?? 0) === 0,
  );
  const itemColumns = [
    { title: "费用内容", dataIndex: "description" },
    {
      title: "审批费用金额",
      dataIndex: "amount",
      render: (v: string) => formatMoney(v),
    },
    { title: "一级分类", dataIndex: "category_l1" },
    { title: "二级分类", dataIndex: "category_l2" },
    {
      title: "报销凭证",
      render: (_: unknown, e: Item) => (
        <Voucher itemId={e.id} count={e.voucher_count} />
      ),
    },
  ];
  async function save() {
    const values = await form.validateFields().catch(() => null);
    if (!values || !bank || !approval) return;
    if (approval.items.some((e) => !selected[e.id])) {
      message.error("请为每条费用选择二级分类");
      return;
    }
    setSaving(true);
    try {
      await apiClient.request(`/api/preopening/stores/${storeId}/matches`, {
        method: "POST",
        body: JSON.stringify({
          approval_id: approval.id,
          bank_transaction_id: bank.id,
          amount: values.amount,
          categories: selected,
        }),
      });
      setIsConfirmOpen(false);
      setSelectedItemIds([]);
      setBank(null);
      setApproval(null);
      message.success("对账已确认");
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }
  async function execute() {
    if (!confirmAction) return;
    setSaving(true);
    try {
      await apiClient.request(
        `/api/preopening/stores/${storeId}/${confirmAction === "close" ? "close" : `matches/${confirmAction.id}/unmatch`}`,
        { method: "POST" },
      );
      setConfirmAction(null);
      message.success("操作完成");
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : "操作失败");
    } finally {
      setSaving(false);
    }
  }
  return (
    <AppShell title="门店筹建费用">
      <StoreLedgerWorkspaceNav
        storeId={storeId}
        storeName={data?.store_name}
        activeKey="preopening"
      />
      {error ? (
        <Alert
          type="error"
          showIcon
          message={error}
          action={<Button onClick={() => void load()}>重试</Button>}
        />
      ) : null}
      <Card
        title="筹建费用"
        loading={loading && !data}
        extra={
          <Space>
            <Tag color={closed ? "default" : "green"}>
              {closed ? "已封账" : "进行中"}
            </Tag>
            {!closed ? (
              <Button
                onClick={() => setConfirmAction("close")}
                disabled={!data || loading}
              >
                封账
              </Button>
            ) : null}
          </Space>
        }
      >
        <Tabs
          items={[
            {
              key: "report",
              label: "筹建报表",
              children: (
                <Space direction="vertical" size={24} style={{ width: "100%" }}>
                  <Statistic
                    title="累计筹建支出"
                    value={Number(data?.total ?? 0)}
                    precision={2}
                    prefix="¥"
                    valueStyle={{ fontSize: 36 }}
                  />
                  <Table
                    loading={loading}
                    rowKey="key"
                    pagination={false}
                    dataSource={categoryRows}
                    columns={[
                      { title: "费用分类", dataIndex: "name" },
                      {
                        title: "金额",
                        dataIndex: "amount",
                        render: (v: number) => formatMoney(v),
                      },
                      {
                        title: "占总支出",
                        render: (_, r) =>
                          Number(data?.total)
                            ? `${((r.amount / Number(data?.total)) * 100).toFixed(2)}%`
                            : "/",
                      },
                      {
                        title: "操作",
                        render: (_, r) => (
                          <Button
                            type="link"
                            onClick={() => {
                              setDetailTitle(r.key);
                              setDetail(
                                data?.details.filter((e) =>
                                  r.key.includes("/")
                                    ? `${e.category_l1}/${e.category_l2}` ===
                                      r.key
                                    : e.category_l1 === r.key,
                                ) ?? [],
                              );
                            }}
                          >
                            查看明细
                          </Button>
                        ),
                      },
                    ]}
                  />
                  <Typography.Title level={5}>支出明细</Typography.Title>
                  <Table
                    rowKey="id"
                    loading={loading}
                    dataSource={data?.details ?? []}
                    columns={[
                      { title: "审批编号", dataIndex: "approval_no" },
                      {
                        title: "申请日期",
                        dataIndex: "submit_time",
                        render: (v: string) => v?.slice(0, 10) || "-",
                      },
                      ...itemColumns,
                    ]}
                    scroll={{ x: 1000 }}
                  />
                </Space>
              ),
            },
            {
              key: "matching",
              label: "筹建审批单对账",
              children: (
                <Space direction="vertical" size={16} style={{ width: "100%" }}>
                  <Form
                    form={filterForm}
                    layout="inline"
                    onFinish={(values) => {
                      const next: Record<string, string> = {};
                      if (values.counterparty_name?.trim())
                        next.counterparty_name =
                          values.counterparty_name.trim();
                      if (values.amount !== undefined && values.amount !== null)
                        next.amount = String(values.amount);
                      if (values.dates?.length) {
                        next.occurred_from = values.dates[0].format(
                          "YYYY-MM-DDT00:00:00",
                        );
                        next.occurred_to = values.dates[1].format(
                          "YYYY-MM-DDT23:59:59",
                        );
                      }
                      setBankPage(1);
                      setFilters(next);
                    }}
                  >
                    <Form.Item name="dates" label="发生日期">
                      <DatePicker.RangePicker locale={zhCN} />
                    </Form.Item>
                    <Form.Item name="counterparty_name" label="户名">
                      <Input allowClear />
                    </Form.Item>
                    <Form.Item name="amount" label="金额">
                      <InputNumber min={0} precision={2} />
                    </Form.Item>
                    <Button htmlType="submit" type="primary" loading={loading}>
                      查询
                    </Button>
                    <Button
                      onClick={() => {
                        filterForm.resetFields();
                        setBankPage(1);
                        setFilters({});
                      }}
                    >
                      重置
                    </Button>
                  </Form>
                  <Row gutter={[16, 16]}>
                    <Col xs={24} xl={9}>
                      <Card title="银行流水" className="data-table-card">
                        <Spin spinning={loading}>
                          <div className="bank-transaction-list">
                            {bankRows.map((b) => (
                              <button
                                key={b.id}
                                type="button"
                                disabled={closed}
                                className={`bank-transaction-card${bank?.id === b.id ? " is-selected" : ""}`}
                                onClick={() => {
                                  setBank(b);
                                  setApproval(null);
                                  setSelected({});
                                }}
                              >
                                <span className="bank-transaction-card__main">
                                  <Typography.Text strong>
                                    {b.counterparty_name || "-"}
                                  </Typography.Text>
                                  <span className="bank-transaction-card__meta">
                                    发生日期：
                                    {b.occurred_at?.slice(0, 10) || "-"}
                                  </span>
                                  <Typography.Text type="secondary">
                                    {b.summary || "无摘要"}
                                  </Typography.Text>
                                </span>
                                <span className="bank-transaction-card__amounts">
                                  <Typography.Text className="bank-transaction-card__amount">
                                    {formatMoney(b.amount)}
                                  </Typography.Text>
                                </span>
                              </button>
                            ))}
                            {!bankRows.length && (
                              <Empty
                                image={Empty.PRESENTED_IMAGE_SIMPLE}
                                description="暂无待对账银行流水"
                              />
                            )}
                          </div>
                          <Pagination
                            size="small"
                            current={bankPage}
                            pageSize={20}
                            total={bankTotal}
                            showSizeChanger={false}
                            onChange={setBankPage}
                            style={{ marginTop: 16 }}
                          />
                        </Spin>
                      </Card>
                    </Col>
                    <Col xs={24} xl={15}>
                      <Card
                        title={
                          bank
                            ? `审批单候选：${formatMoney(bank.amount)}`
                            : "审批单候选"
                        }
                        className="data-table-card approval-candidate-panel"
                        extra={
                          <Button
                            type="primary"
                            disabled={
                              !bank || !approval || closed || candidateLoading
                            }
                            onClick={() => {
                              if (!bank || !approval) return;
                              setSelectedItemIds([]);
                              form.setFieldsValue({
                                amount: Math.min(
                                  Number(bank.amount),
                                  Math.max(
                                    0,
                                    Number(approval.amount) -
                                      (data?.matches ?? [])
                                        .filter(
                                          (match) =>
                                            match.approval_id === approval.id,
                                        )
                                        .reduce(
                                          (sum, match) =>
                                            sum + Number(match.amount),
                                          0,
                                        ),
                                  ),
                                ),
                              });
                              setIsConfirmOpen(true);
                            }}
                          >
                            确认匹配
                          </Button>
                        }
                      >
                        <Input.Search
                          placeholder="搜索审批编号"
                          allowClear
                          value={approvalSearch}
                          onChange={(event) => {
                            setApprovalSearch(event.target.value);
                            setCandidatePage(1);
                          }}
                          style={{ marginBottom: 16, maxWidth: 320 }}
                        />
                        <Spin spinning={candidateLoading}>
                          <div className="approval-candidate-list">
                            {candidates
                              .filter(
                                (a) =>
                                  !approvalSearch ||
                                  a.approval_no?.includes(approvalSearch),
                              )
                              .slice(
                                (candidatePage - 1) * 10,
                                candidatePage * 10,
                              )
                              .map((a) => (
                                <div
                                  key={a.id}
                                  role="button"
                                  tabIndex={0}
                                  className={`approval-candidate-card${approval?.id === a.id ? " is-selected" : ""}`}
                                  onClick={() => {
                                    setApproval(a);
                                    setSelected(
                                      Object.fromEntries(
                                        a.items
                                          .filter((e) => e.category_id)
                                          .map((e) => [e.id, e.category_id!]),
                                      ),
                                    );
                                  }}
                                  onKeyDown={(event) => {
                                    if (
                                      event.key === "Enter" ||
                                      event.key === " "
                                    ) {
                                      event.preventDefault();
                                      setApproval(a);
                                      setSelected(
                                        Object.fromEntries(
                                          a.items
                                            .filter((e) => e.category_id)
                                            .map((e) => [e.id, e.category_id!]),
                                        ),
                                      );
                                    }
                                  }}
                                >
                                  <Tooltip title={a.reason}>
                                    <div className="approval-candidate-card__score">
                                      <span>
                                        {Number(a.score ?? 0) === 100
                                          ? "100"
                                          : Number(a.score ?? 0).toFixed(1)}
                                        %
                                      </span>
                                      <Typography.Text type="secondary">
                                        推荐度
                                      </Typography.Text>
                                    </div>
                                  </Tooltip>
                                  <div className="approval-candidate-card__main">
                                    <Typography.Text strong>
                                      {a.approval_no}
                                    </Typography.Text>
                                    <Typography.Text
                                      className="approval-candidate-card__title"
                                      ellipsis
                                    >
                                      {a.items
                                        .map((e) => e.description)
                                        .join("、") || "-"}
                                    </Typography.Text>
                                    <Space
                                      wrap
                                      className="approval-candidate-card__meta"
                                    >
                                      <span>
                                        申请日期：
                                        {a.submit_time?.slice(0, 10) || "-"}
                                      </span>
                                      <span>
                                        完成日期：
                                        {a.finish_time?.slice(0, 10) || "-"}
                                      </span>
                                    </Space>
                                  </div>
                                  <div className="approval-candidate-card__aside">
                                    <Typography.Text className="approval-candidate-card__amount">
                                      {formatMoney(a.amount)}
                                    </Typography.Text>
                                    <Typography.Text type="secondary">
                                      审批单总额
                                    </Typography.Text>
                                    <Button
                                      size="small"
                                      type="primary"
                                      ghost
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setDetailTitle(
                                          `审批费用明细 · ${a.approval_no}`,
                                        );
                                        setDetail(a.items);
                                      }}
                                    >
                                      查看明细
                                    </Button>
                                  </div>
                                </div>
                              ))}
                            {!candidates.filter(
                              (a) =>
                                !approvalSearch ||
                                a.approval_no?.includes(approvalSearch),
                            ).length && (
                              <Empty
                                image={Empty.PRESENTED_IMAGE_SIMPLE}
                                description={
                                  bank
                                    ? "暂无符合条件的审批单"
                                    : "请先选择银行流水"
                                }
                              />
                            )}
                          </div>
                          <Pagination
                            size="small"
                            current={candidatePage}
                            pageSize={10}
                            total={
                              candidates.filter(
                                (a) =>
                                  !approvalSearch ||
                                  a.approval_no?.includes(approvalSearch),
                              ).length
                            }
                            showSizeChanger={false}
                            onChange={setCandidatePage}
                            style={{ marginTop: 16 }}
                          />
                        </Spin>
                      </Card>
                    </Col>
                  </Row>

                </Space>
              ),
            },
            {
              key: "matched",
              label: `已匹配记录（${data?.matches.length ?? 0}）`,
              children: (
                  <Table
                    rowKey="id"
                    loading={loading}
                    dataSource={data?.matches ?? []}
                    scroll={{ x: 1000 }}
                    columns={[
                      {
                        title: "审批编号",
                        render: (_, m) =>
                          data?.approvals.find((a) => a.id === m.approval_id)
                            ?.approval_no ?? m.approval_id,
                      },
                      {
                        title: "流水户名",
                        render: (_, m) => m.counterparty_name ?? "-",
                      },
                      {
                        title: "流水日期",
                        dataIndex: "occurred_at",
                        render: (v?: string) => v ? v.slice(0, 10) : "-",
                      },
                      {
                        title: "匹配时间",
                        dataIndex: "confirmed_at",
                        render: (v?: string) => v ? v.replace("T", " ").slice(0, 19) : "-",
                      },
                      {
                        title: "匹配金额",
                        dataIndex: "amount",
                        render: (v: string) => formatMoney(v),
                      },
                      {
                        title: "操作",
                        render: (_, m) => (
                          <Space>
                            <Button
                              type="link"
                              onClick={() => {
                                setDetailTitle("审批费用明细");
                                setDetail(
                                  data?.approvals.find(
                                    (a) => a.id === m.approval_id,
                                  )?.items ?? [],
                                );
                              }}
                            >
                              详情
                            </Button>
                            <Button
                              type="link"
                              danger
                              disabled={closed}
                              onClick={() => setConfirmAction(m)}
                            >
                              撤销
                            </Button>
                          </Space>
                        ),
                      },
                    ]}
                  />
              ),
            },
          ]}
        />
      </Card>
      <Modal
        title={
          <Space direction="vertical" size={2}>
            <Typography.Text strong>匹配并分类</Typography.Text>
            <Typography.Text
              type="secondary"
              className="reconciliation-confirm-modal__subtitle"
            >
              确认匹配金额和筹建费用分类
            </Typography.Text>
          </Space>
        }
        className="reconciliation-confirm-modal"
        open={isConfirmOpen}
        onCancel={() => {
          if (!saving) setIsConfirmOpen(false);
        }}
        width={980}
        onOk={() => void save()}
        confirmLoading={saving}
        okText="确认匹配"
        cancelText="取消"
        okButtonProps={{ disabled: !bank || !approval || closed }}
      >
        <Form form={form} layout="vertical">
          <div className="reconciliation-confirm-summary">
            <div className="reconciliation-confirm-summary__item">
              <Typography.Text type="secondary">银行流水</Typography.Text>
              <Typography.Text strong>
                {bank?.counterparty_name || "-"}
              </Typography.Text>
              <Typography.Text className="reconciliation-confirm-summary__amount">
                {formatMoney(bank?.amount ?? 0)}
              </Typography.Text>
              <Typography.Text className="reconciliation-confirm-summary__date">
                发生日期：{bank?.occurred_at?.slice(0, 10) || "-"}
              </Typography.Text>
            </div>
            <div className="reconciliation-confirm-summary__item">
              <Typography.Text type="secondary">当前审批单</Typography.Text>
              <Typography.Text strong>
                {approval?.approval_no || "-"}
              </Typography.Text>
              <Typography.Text className="reconciliation-confirm-summary__amount">
                {formatMoney(approval?.amount ?? 0)}
              </Typography.Text>
              <Typography.Text>
                申请日期：{approval?.submit_time?.slice(0, 10) || "-"}
              </Typography.Text>
              <Typography.Text className="reconciliation-confirm-summary__date">
                完成日期：{approval?.finish_time?.slice(0, 10) || "-"}
              </Typography.Text>
            </div>
          </div>
          <div className="reconciliation-confirm-detail-panel">
            <div className="reconciliation-confirm-detail-panel__header">
              <Typography.Text strong>审批费用明细</Typography.Text>
              <Typography.Text type="secondary">
                选择明细后批量设置分类
              </Typography.Text>
            </div>
            <Table
              size="small"
              rowKey="id"
              dataSource={approval?.items ?? []}
              pagination={false}
              scroll={{ x: 860, y: 300 }}
              rowSelection={{
                selectedRowKeys: selectedItemIds,
                onChange: (keys) => setSelectedItemIds(keys.map(String)),
                getCheckboxProps: () => ({ disabled: saving }),
              }}
              columns={[
                {
                  title: "费用内容",
                  dataIndex: "description",
                  width: 260,
                  render: (value: string) => (
                    <Typography.Text>{value || "-"}</Typography.Text>
                  ),
                },
                {
                  title: "金额",
                  dataIndex: "amount",
                  width: 110,
                  align: "right",
                  render: (value: string) => (
                    <Typography.Text className="reconciliation-confirm-detail-amount">
                      {formatMoney(value)}
                    </Typography.Text>
                  ),
                },
                {
                  title: "分类",
                  width: 260,
                  render: (_, e) => {
                    const c = categories.find((c) => c.id === selected[e.id]);
                    return (
                      <Cascader
                        style={{ width: "100%" }}
                        size="large"
                        options={options}
                        value={c ? [c.parent_id!, c.id] : undefined}
                        showSearch
                        changeOnSelect={false}
                        disabled={saving}
                        status={!selected[e.id] ? "error" : undefined}
                        popupClassName="reconciliation-confirm-category-popup"
                        onChange={(v) =>
                          setSelected((s) => {
                            const targetIds = selectedItemIds.includes(e.id)
                              ? selectedItemIds
                              : [e.id];
                            const next = { ...s };
                            targetIds.forEach((id) => {
                              next[id] = v.length === 2 ? String(v[1]) : "";
                            });
                            return next;
                          })
                        }
                        placeholder="选择二级分类"
                      />
                    );
                  },
                },
                {
                  title: "报销凭证",
                  width: 180,
                  render: (_, e) => (
                    <Voucher itemId={e.id} count={e.voucher_count} />
                  ),
                },
              ]}
            />
          </div>
          <div className="reconciliation-confirm-fields">
            <Form.Item
              name="amount"
              label="匹配金额"
              rules={[{ required: true, message: "请输入匹配金额" }]}
            >
              <InputNumber
                min={0.01}
                max={bank ? Number(bank.amount) : undefined}
                precision={2}
                disabled={saving}
                style={{ width: "100%" }}
              />
            </Form.Item>
          </div>
        </Form>
      </Modal>
      <Modal
        title={detailTitle}
        open={detail !== null}
        onCancel={() => setDetail(null)}
        footer={null}
        width={1000}
      >
        <Table rowKey="id" dataSource={detail ?? []} columns={itemColumns} />
      </Modal>
      <Modal
        title={
          confirmAction === "close" ? "确认筹建报表封账？" : "确认撤销对账？"
        }
        open={!!confirmAction}
        onCancel={() => {
          if (!saving) setConfirmAction(null);
        }}
        onOk={() => void execute()}
        confirmLoading={saving}
      >
        {confirmAction === "close"
          ? `累计支出 ${formatMoney(data?.total ?? 0)}。封账后不能新增或修改筹建对账，第一期不支持解封。`
          : "撤销后按剩余有效匹配重新统计审批费用。"}
      </Modal>
    </AppShell>
  );
}
