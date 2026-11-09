import { Button, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useState } from "react";
import type { BankTransactionBusinessDetail } from "@fin-hub/shared-types";
import { api, API_BASE_URL, getShareholderToken } from "../../lib/api";
const postingLabels: Record<string, string> = { bank_interest: "银行结息", other_income: "其他收入", bank_fee: "银行手续费", bank_sms_fee: "银行短信费", bank_other_expense: "银行其他支出" };
const money = (x: unknown) => x == null ? "—" : "¥" + Number(x).toFixed(2);
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
  async function preview(attachmentId: string, isImage: boolean) {
    try {
      const result = await Taro.downloadFile({
        url: API_BASE_URL + "/api/miniapp/attachments/" + attachmentId,
        header: { authorization: "Bearer " + getShareholderToken() },
      });
      if (result.statusCode !== 200) throw new Error("凭证暂不可用");
      if (isImage) await Taro.previewImage({ urls: [result.tempFilePath] });
      else
        await Taro.openDocument({
          filePath: result.tempFilePath,
          showMenu: true,
        });
    } catch (e) {
      Taro.showToast({
        title: e instanceof Error ? e.message : "预览失败",
        icon: "none",
      });
    }
  }
  return (
    <View className="page">
      <Text className="title">流水业务详情</Text>
      {busy && <Text>正在加载…</Text>}
      {error && (
        <View>
          <Text>{error}</Text>
          <Button onClick={load}>重试</Button>
        </View>
      )}
      {data && (
        <>
          <View className="section">
            <Text className="value">{money(data.transaction.amount)}</Text>
            <Text>{data.transaction.counterparty_name || "未填写户名"}</Text>
            <Text>{data.transaction.occurred_at.slice(0, 10)}</Text>
            <Text>{data.special_label}</Text>
            <Text>{data.remark || "无备注"}</Text>
          </View>
          <Button onClick={() => SD(!showDetails)}>{showDetails ? "收起详情" : "详情"}</Button>
          {showDetails && <View className="section">
            <Text className="section-title">流水完整信息</Text>
            {[
              ["发生时间", data.transaction.occurred_at.replace("T", " ")],
              ["方向", data.transaction.direction === "income" ? "收入" : "支出"],
              ["金额", money(data.transaction.amount)],
              ["对方户名", data.transaction.counterparty_name],
              ["对方账号", data.transaction.counterparty_account],
              ["银行流水号", data.transaction.bank_serial_no],
              ["流水属性", data.special_label || "普通流水"],
              ["直接入账", postingLabels[data.transaction.direct_posting_type || ""] || "—"],
              ["付款情况", data.transaction.payment_status === "paid" ? "已实付" : "未实付"],
              ["已匹配金额", money(data.transaction.matched_amount)],
              ["入账月份", data.transaction.accounting_periods?.join("、") || "待入账"],
              ["流水备注", data.transaction.summary || data.remark],
              ["录入时间", data.transaction.created_at],
              ["更新时间", data.transaction.updated_at],
            ].map(([label, value]) => <View className="row" key={String(label)}><Text>{label}</Text><Text>{value || "—"}</Text></View>)}
          </View>}
          {data.expenses.map((x, i) => (
            <View className="section" key={x.expense_item_id + i}>
              <Text className="section-title">
                关联报销 {x.approval_no || ""}
              </Text>
              <Text>报销单总额 {money(x.approval_total_amount)}</Text>
              <Text>
                {x.applicant_name} · {x.submit_at?.slice(0, 10)}
              </Text>
              <View className="row">
                <Text>
                  {x.category_l1} / {x.category_l2}
                </Text>
                <Text>{x.description}</Text>
                <Text>{money(x.amount)}</Text>
              </View>
              {x.attachments.map((a) => (
                <Button
                  key={a.id}
                  onClick={() =>
                    preview(a.id, Boolean(a.content_type?.startsWith("image/")))
                  }
                >
                  查看凭证 · {a.file_name}
                </Button>
              ))}
            </View>
          ))}
          {data.revenues.map((x) => (
            <View className="section" key={x.match_id}>
              <Text className="section-title">
                {x.channel} · {money(x.amount)}
              </Text>
              <Text>
                {x.revenue_start_date} 至 {x.revenue_end_date}
              </Text>
              {x.records.map((r) => (
                <View className="row" key={r.id}>
                  <Text>
                    {r.revenue_date} · {r.channel}
                  </Text>
                  <Text>
                    营业 {money(r.gross_amount)} · 实收 {money(r.net_amount)}
                  </Text>
                </View>
              ))}
            </View>
          ))}
          {!data.expenses.length && !data.revenues.length && (
            <View className="section">
              暂无关联报销或营业收入，业务说明见流水备注
            </View>
          )}
        </>
      )}
    </View>
  );
}
