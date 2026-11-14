import Taro from "@tarojs/taro";
import type { Attachment } from "@fin-hub/shared-types";
import { API_BASE_URL, getShareholderToken } from "./api";
import { networkIssue } from "./diagnostics";

export async function previewAttachment(
  attachment: Pick<Attachment, "id" | "file_name" | "content_type">,
): Promise<void> {
  let result;
  try {
    result = await Taro.downloadFile({
      url: API_BASE_URL + "/api/miniapp/attachments/" + attachment.id,
      header: { authorization: "Bearer " + getShareholderToken() },
    });
  } catch (error) {
    throw new Error(networkIssue(error).message);
  }
  if (result.statusCode === 401)
    throw new Error("登录已失效，请重新登录后查看凭证");
  if (result.statusCode !== 200 || !result.tempFilePath)
    throw new Error("凭证暂不可用或查看权限已变化");
  const extension = /\.([a-z0-9]+)$/i
    .exec(attachment.file_name || "")?.[1]
    ?.toLowerCase();
  // Synced DingTalk attachments can have a filename but no stored MIME type.
  const isImage =
    attachment.content_type?.toLowerCase().startsWith("image/") ||
    /^(png|jpe?g|webp|gif|bmp)$/.test(extension || "");
  try {
    if (isImage) {
      await Taro.previewImage({
        current: result.tempFilePath,
        urls: [result.tempFilePath],
      });
    } else {
      const fileType = /^(pdf|docx?|xlsx?|pptx?)$/.test(extension || "")
        ? (extension as
            | "pdf"
            | "doc"
            | "docx"
            | "xls"
            | "xlsx"
            | "ppt"
            | "pptx")
        : undefined;
      await Taro.openDocument({
        filePath: result.tempFilePath,
        fileType,
        showMenu: true,
      });
    }
  } catch {
    throw new Error(
      isImage ? "图片预览失败，请重试" : "文档打开失败，请确认文件格式受支持",
    );
  }
}
