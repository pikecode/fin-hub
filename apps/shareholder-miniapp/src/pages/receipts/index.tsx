import { Button, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useState } from "react";
import type { Attachment } from "@fin-hub/shared-types";
import { api } from "../../lib/api";
import { previewAttachment } from "../../lib/attachments";
export default function Receipts() {
  const { type = "expense_item", id = "" } = Taro.useRouter().params;
  const [rows, R] = useState<Attachment[] | null>(null),
    [error, E] = useState(""),
    [retry, X] = useState(0);
  useEffect(() => {
    let live = true;
    R(null);
    E("");
    api
      .recordAttachments(type, id)
      .then((r) => {
        if (live) R(r);
      })
      .catch((e) => {
        if (live) E(e.message);
      });
    return () => {
      live = false;
    };
  }, [type, id, retry]);
  async function open(a: Attachment) {
    try {
      await previewAttachment(a);
    } catch (e) {
      Taro.showToast({
        title: e instanceof Error ? e.message : "打开失败",
        icon: "none",
      });
    }
  }
  return (
    <View className="page detail-page">
      <Text className="eyebrow">附件与图片</Text>
      <Text className="detail-page-title">报表凭证</Text>
      {error ? (
        <View className="section empty-state">
          <Text className="empty-title">暂时无法读取凭证</Text>
          <Text className="empty-description">{error}</Text>
          <Button className="secondary-button" onClick={() => X(retry + 1)}>
            重新加载
          </Button>
        </View>
      ) : rows === null ? (
        <View className="section">
          <Text className="row-sub">正在读取凭证…</Text>
        </View>
      ) : !rows.length ? (
        <View className="section empty-state">
          <Text className="empty-symbol">—</Text>
          <Text className="empty-title">暂未上传凭证</Text>
          <Text className="empty-description">
            财务上传附件后，可在这里预览或保存。
          </Text>
        </View>
      ) : (
        <View className="section">
          <Text className="section-title">附件 · {rows.length} 份</Text>
          {rows.map((attachment) => (
            <Button
              className="receipt-link"
              key={attachment.id}
              onClick={() => open(attachment)}
            >
              <Text className="file-badge">
                {attachment.content_type?.startsWith("image/")
                  ? "图片"
                  : attachment.file_name.split(".").pop()?.toUpperCase() ||
                    "文件"}
              </Text>
              <Text>{attachment.file_name}</Text>
              <Text>›</Text>
            </Button>
          ))}
          <Text className="row-sub">
            点击文件预览，可通过微信菜单保存或转发。
          </Text>
        </View>
      )}
    </View>
  );
}
