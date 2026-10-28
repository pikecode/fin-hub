import { Button, Image, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useState } from "react";
import type { BankTransactionBusinessDetail } from "@fin-hub/shared-types";
import { api, API_BASE_URL, getShareholderToken } from "../../lib/api";
const money = (x: unknown) => "¥" + Number(x || 0).toFixed(2);
export default function Detail() {
  const { id } = Taro.useRouter().params;
  const [data, D] = useState<BankTransactionBusinessDetail | null>(null),
    [error, E] = useState(""),
    [busy, B] = useState(false);
  async function load() {
    B(true);
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
