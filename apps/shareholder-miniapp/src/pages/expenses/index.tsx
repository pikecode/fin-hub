import { Button, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useState } from "react";
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
}
export default function Expenses() {
  const p = Taro.useRouter().params;
  const [data, D] = useState<{ items: Row[]; total: number } | null>(null),
    [page, P] = useState(1),
    [error, E] = useState("");
  useEffect(() => {
    let live = true;
    D(null);
    E("");
    request<{ items: Row[]; total: number }>(
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
  }, [page, p.storeId, p.period, p.category]);
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
    <View className="page">
      <Text className="title">{p.category || "费用明细"}</Text>
      {error && <Text className="error">{error}</Text>}
      {!data && !error && <Text>正在加载…</Text>}
      {data?.items.map((x) => (
        <View className="section" key={x.id}>
          <Text>{x.date}</Text>
          <Text>{x.description}</Text>
          <Text className="value">¥{Number(x.amount).toFixed(2)}</Text>
          {x.attachments.map((a) => (
            <Button key={a.id} onClick={() => preview(a)}>
              查看凭证 · {a.file_name}
            </Button>
          ))}
        </View>
      ))}
      {data && (
        <View className="filters">
          <Button disabled={page === 1} onClick={() => P(page - 1)}>
            上一页
          </Button>
          <Text>
            {page} · 共{data.total}条
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
