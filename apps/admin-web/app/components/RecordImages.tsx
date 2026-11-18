"use client";
import { Button, Image, Space, Upload, message } from "antd";
import { useEffect, useState } from "react";
import type { Attachment } from "@fin-hub/shared-types";
import { apiClient } from "../lib/api";
import { compressVoucherImage } from "../lib/compressVoucherImage";
export function RecordImages({ resourceType, resourceId, readonly = false }: { resourceType: string; resourceId: string; readonly?: boolean }) {
  const [uploading, setUploading] = useState(false);
  const [rows, setRows] = useState<Attachment[]>([]);
  const [urls, setUrls] = useState<string[]>([]);
  const [version, reload] = useState(0);
  useEffect(() => {
    let cancelled = false; const allocated: string[] = [];
    apiClient.attachments.list(`?resource_type=${resourceType}&resource_id=${resourceId}&page_size=100`).then(async page => {
      if (!cancelled) setRows(page.items);
      for (const row of page.items) {
        const blob = await apiClient.attachments.download(row.id);
        if (cancelled) return;
        allocated.push(URL.createObjectURL(blob));
      }
      if (!cancelled) setUrls([...allocated]);
    }).catch(e => { if (!cancelled) message.error(e.message); });
    return () => { cancelled = true; allocated.forEach(url => URL.revokeObjectURL(url)); };
  }, [resourceType, resourceId, version]);
  return <Space wrap><Image.PreviewGroup>{urls.map((url, i) => <Image key={url} src={url} width={70} alt={rows[i]?.file_name || "凭证"} />)}</Image.PreviewGroup>{!readonly && <Upload accept="image/png,image/jpeg" showUploadList={false} disabled={uploading} beforeUpload={async file => {
    setUploading(true);
    try { const body = new FormData(); const prepared = await compressVoucherImage(file); body.append("file", prepared); await apiClient.attachments.upload(resourceType, resourceId, body); reload(x => x + 1); message.success(prepared === file ? "凭证上传成功" : "图片已自动压缩并上传"); }
    catch (e) { message.error(e instanceof Error ? e.message : "上传失败"); } finally { setUploading(false); } return false;
  }}><Button loading={uploading}>{uploading ? "处理并上传中" : "上传图片凭证（大图自动压缩）"}</Button></Upload>}</Space>;
}
