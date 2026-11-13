import { Button, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useState } from "react";
import { formatMoney } from "@fin-hub/shared-utils";
import type { Attachment } from "@fin-hub/shared-types";
import { request, API_BASE_URL, getShareholderToken } from "../../lib/api";
interface Row {
  id: string;
  date: string;
  description: string;
  amount: string;
  category_l1: string;
  category_l2: string;
  attachments: Attachment[];
  source?: string;
  source_document_id?: string;
}
export default function Expenses() {
  const p = Taro.useRouter().params;
  const [data, D] = useState<{
      items: Row[];
      total: number;
      total_amount?: string;
    } | null>(null),
    [page, P] = useState(1),
    [error, E] = useState(""),
    [retry, retryLoad] = useState(0);
  useEffect(() => {
    let live = true;
    D(null);
    E("");
    request<{ items: Row[]; total: number; total_amount?: string }>(
      `/expenses?store_id=${p.storeId}&period=${p.period}&category=${encodeURIComponent(p.category || "")}&page=${page}`,
    )
      .then((r) => {
        if (live) D(r);
      })
      .catch((e) => {
        if (live) E(e.message);
      });
    return () => {
      live = false;
    };
  }, [page, p.storeId, p.period, p.category, retry]);
  async function preview(a: Attachment) {
    try {
      const r = await Taro.downloadFile({
        url: API_BASE_URL + "/api/miniapp/attachments/" + a.id,
        header: { authorization: "Bearer " + getShareholderToken() },
      });
      if (r.statusCode !== 200) throw new Error("凭证暂不可用");
      if (a.content_type?.startsWith("image/"))
        await Taro.previewImage({ urls: [r.tempFilePath] });
      else
        await Taro.openDocument({ filePath: r.tempFilePath, showMenu: true });
    } catch (e) {
      Taro.showToast({
        title: e instanceof Error ? e.message : "预览失败",
        icon: "none",
      });
    }
  }
  return (
    <View className="page detail-page">
      <Text className="eyebrow">{p.period} · 费用明细</Text>
      <Text className="detail-page-title">{p.category || "全部费用"}</Text>
      {error && (
        <View className="section empty-state">
          <Text className="empty-title">暂时无法读取费用</Text>
          <Text className="empty-description">{error}</Text>
          <Button
            className="secondary-button"
            onClick={() => retryLoad(retry + 1)}
          >
            重新加载
          </Button>
        </View>
      )}
      {!data && !error && (
        <View className="section">
          <Text className="row-sub">正在读取费用明细…</Text>
        </View>
      )}
      {data && (
        <View className="section expense-total">
          <View>
            <Text className="label">入账合计</Text>
            <Text className="balance-value">
              {data.total_amount == null ? "—" : formatMoney(data.total_amount)}
            </Text>
          </View>
          <Text className="status-badge">{data.total} 条记录</Text>
        </View>
      )}
      {data && !data.items.length && (
        <View className="section empty-state">
          <Text className="empty-title">本月暂无费用明细</Text>
          <Text className="empty-description">
            可返回报表查看其他分类或月份。
          </Text>
        </View>
      )}
      {data?.items.map((item) => (
        <View className="section" key={item.id}>
          <View className="report-line">
            <Text className="row-sub">{item.date}</Text>
            <Text className="detail-money">{formatMoney(item.amount)}</Text>
          </View>
          <Text className="expense-description">{item.description}</Text>
          <Text className="row-sub">
            {[item.category_l1, item.category_l2].filter(Boolean).join(" / ") ||
              "未分类"}{" "}
            ·{" "}
            {item.source === "accrual"
              ? "计提/调整"
              : item.source === "bank_direct"
                ? "银行直接入账"
                : item.source === "kuailv_purchase"
                  ? "采购"
                  : "费用"}
          </Text>
          {item.source === "bank_direct" && item.source_document_id && (
            <Button
              className="list-more"
              onClick={() =>
                Taro.navigateTo({
                  url: "/pages/bank-detail/index?id=" + item.source_document_id,
                })
              }
            >
              查看原流水 ›
            </Button>
          )}
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
      {data && data.total > 30 && (
        <View className="mobile-pagination">
          <Button disabled={page === 1} onClick={() => P(page - 1)}>
            上一页
          </Button>
          <Text>
            {page} / {Math.ceil(data.total / 30)}
          </Text>
          <Button
            disabled={page * 30 >= data.total}
            onClick={() => P(page + 1)}
          >
            下一页
          </Button>
        </View>
      )}
    </View>
  );
}
