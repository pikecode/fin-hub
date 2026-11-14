import { Button, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useState } from "react";
import { formatMoney } from "@fin-hub/shared-utils";
import type {
  Attachment,
  BankTransactionBusinessDetail,
} from "@fin-hub/shared-types";
import { api } from "../../lib/api";
import { previewAttachment } from "../../lib/attachments";
const postingLabels: Record<string, string> = {
  bank_interest: "银行结息",
  other_income: "其他收入",
  bank_fee: "银行手续费",
  bank_sms_fee: "银行短信费",
  bank_other_expense: "银行其他支出",
};
const money = (x: unknown) => (x == null ? "—" : formatMoney(String(x)));
export default function Detail() {
  const { id } = Taro.useRouter().params;
  const [data, D] = useState<BankTransactionBusinessDetail | null>(null),
    [showDetails, SD] = useState(Taro.useRouter().params.details === "1"),
    [error, E] = useState(""),
    [busy, B] = useState(false);
  async function load() {
    B(true);
    D(null);
    E("");
    try {
      D(await api.bankDetail(id || ""));
    } catch (e) {
      E(e instanceof Error ? e.message : "加载失败");
    } finally {
      B(false);
    }
  }
  useEffect(() => {
    load();
  }, [id]);
  async function preview(attachment: Attachment) {
    try {
      await previewAttachment(attachment);
    } catch (e) {
      Taro.showToast({
        title: e instanceof Error ? e.message : "预览失败",
        icon: "none",
      });
    }
  }
  return (
    <View className="page detail-page">
      {busy && (
        <View className="section empty-state">
          <Text className="empty-description">正在读取流水信息…</Text>
        </View>
      )}
      {error && (
        <View className="section empty-state">
          <Text className="empty-title">暂时无法读取流水</Text>
          <Text className="empty-description">{error}</Text>
          <Button className="secondary-button" onClick={load}>
            重新加载
          </Button>
        </View>
      )}
      {data && (
        <>
          <View className="section transaction-summary">
            <Text className="label">
              {data.transaction.direction === "income"
                ? "收入金额"
                : "支出金额"}
            </Text>
            <Text className="transaction-amount">
              {data.transaction.direction === "income" ? "+" : "−"}
              {money(data.transaction.amount)}
            </Text>
            <Text className="transaction-name">
              {data.transaction.counterparty_name || "未填写户名"}
            </Text>
            <View className="transaction-meta">
              <Text>{data.transaction.occurred_at.slice(0, 10)}</Text>
              {data.special_label && (
                <Text className="status-badge">{data.special_label}</Text>
              )}
            </View>
            {data.remark && <Text className="row-sub">{data.remark}</Text>}
          </View>
          <View className="tabs">
            <Button
              className={!showDetails ? "tab active" : "tab"}
              onClick={() => SD(false)}
            >
              关联业务
            </Button>
            <Button
              className={showDetails ? "tab active" : "tab"}
              onClick={() => SD(true)}
            >
              流水信息
            </Button>
          </View>
          {showDetails ? (
            <View className="section">
              <Text className="section-title">流水完整信息</Text>
              {[
                ["发生时间", data.transaction.occurred_at.replace("T", " ")],
                [
                  "方向",
                  data.transaction.direction === "income" ? "收入" : "支出",
                ],
                ["金额", money(data.transaction.amount)],
                ["对方户名", data.transaction.counterparty_name],
                ["对方账号", data.transaction.counterparty_account],
                ["银行流水号", data.transaction.bank_serial_no],
                ["流水属性", data.special_label || "普通流水"],
                [
                  "直接入账",
                  postingLabels[data.transaction.direct_posting_type || ""] ||
                    "—",
                ],
                [
                  "付款情况",
                  data.transaction.payment_status === "paid"
                    ? "已实付"
                    : "未实付",
                ],
                ["已匹配金额", money(data.transaction.matched_amount)],
                [
                  "入账月份",
                  data.transaction.accounting_periods?.join("、") || "待入账",
                ],
                ["流水备注", data.transaction.summary || data.remark],
                ["录入时间", data.transaction.created_at],
                ["更新时间", data.transaction.updated_at],
              ].map(([label, value]) => (
                <View className="information-row" key={String(label)}>
                  <Text>{label}</Text>
                  <Text>{value || "—"}</Text>
                </View>
              ))}
            </View>
          ) : (
            <>
              {data.expenses.map((item, index) => (
                <View className="section" key={item.expense_item_id + index}>
                  <Text className="section-title">关联报销</Text>
                  <View className="business-caption">
                    <Text>{item.approval_no || "费用记录"}</Text>
                    <Text>
                      {item.applicant_name || "—"} ·{" "}
                      {item.submit_at?.slice(0, 10) || "—"}
                    </Text>
                  </View>
                  <View className="information-row">
                    <Text>审批单总额</Text>
                    <Text>{money(item.approval_total_amount)}</Text>
                  </View>
                  <View className="business-expense">
                    <Text className="row-sub">
                      {[item.category_l1, item.category_l2]
                        .filter(Boolean)
                        .join(" / ") || "未分类"}
                    </Text>
                    <Text className="record-description">
                      {item.description}
                    </Text>
                    <Text className="detail-money">{money(item.amount)}</Text>
                  </View>
                  {item.attachments.map((attachment) => (
                    <Button
                      className="receipt-link"
                      key={attachment.id}
                      onClick={() => preview(attachment)}
                    >
                      <Text className="file-badge">凭证</Text>
                      <Text>{attachment.file_name}</Text>
                      <Text>›</Text>
                    </Button>
                  ))}
                </View>
              ))}
              {data.revenues.map((item) => (
                <View className="section" key={item.match_id}>
                  <View className="report-line">
                    <Text className="section-title">{item.channel}</Text>
                    <Text className="list-money">{money(item.amount)}</Text>
                  </View>
                  <Text className="row-sub">
                    {item.revenue_start_date} 至 {item.revenue_end_date}
                  </Text>
                  {item.records.map((record) => (
                    <View className="record-item" key={record.id}>
                      <View className="report-line">
                        <Text>{record.revenue_date}</Text>
                        <Text className="list-money">
                          {money(record.gross_amount)}
                        </Text>
                      </View>
                      <Text className="row-sub">
                        {record.channel} · 实收 {money(record.net_amount)}
                      </Text>
                    </View>
                  ))}
                </View>
              ))}
              {!data.expenses.length && !data.revenues.length && (
                <View className="section empty-state">
                  <Text className="empty-title">暂无关联业务</Text>
                  <Text className="empty-description">
                    可切换到流水信息，查看原始备注与入账属性。
                  </Text>
                  <Button className="secondary-button" onClick={() => SD(true)}>
                    查看流水信息
                  </Button>
                </View>
              )}
            </>
          )}
        </>
      )}
    </View>
  );
}
