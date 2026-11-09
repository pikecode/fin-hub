"use client";
import { Button, Image, Space, Upload, message } from "antd";
import { useEffect, useState } from "react";
import type { Attachment } from "@fin-hub/shared-types";
import { apiClient } from "../lib/api";
export function RecordImages({ resourceType, resourceId, readonly = false }: { resourceType: string; resourceId: string; readonly?: boolean }) {
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
  return <Space wrap><Image.PreviewGroup>{urls.map((url, i) => <Image key={url} src={url} width={70} alt={rows[i]?.file_name || "凭证"} />)}</Image.PreviewGroup>{!readonly && <Upload accept="image/png,image/jpeg" showUploadList={false} beforeUpload={async file => {
    try { const body = new FormData(); body.append("file", file); await apiClient.attachments.upload(resourceType, resourceId, body); reload(x => x + 1); }
    catch (e) { message.error(e instanceof Error ? e.message : "上传失败"); } return false;
  }}><Button>上传图片凭证（≤500KB）</Button></Upload>}</Space>;
}
