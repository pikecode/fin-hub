import { Button, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useState } from "react";
import { API_BASE_URL, getShareholderToken, request } from "../../lib/api";
interface Job {
  id: string;
  status: string;
  error?: string;
  warnings: string[];
  expires_at: string;
}
export default function ExportPage() {
  const { storeId = "", period = "" } = Taro.useRouter().params;
  const [job, J] = useState<Job | null>(null),
    [busy, B] = useState(false),
    [error, E] = useState("");
  async function create() {
    if (busy) return;
    B(true);
    E("");
    try {
      J(await request<Job>("/report-exports", { store_id: storeId, period }));
    } catch (e) {
      E(e instanceof Error ? e.message : "生成失败");
    } finally {
      B(false);
    }
  }
  useEffect(() => {
    if (!job || !["pending", "running"].includes(job.status)) return;
    let live = true;
    const timer = setTimeout(() => {
      request<Job>("/report-exports/" + job.id)
        .then((r) => {
          if (live) {
            J(r);
            E("");
          }
        })
        .catch((e) => {
          if (live) E(e.message);
        });
    }, 2000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [job]);
  async function refresh() {
    if (!job) return;
    try {
      J(await request<Job>("/report-exports/" + job.id));
      E("");
    } catch (e) {
      E(e instanceof Error ? e.message : "查询失败");
    }
  }
  async function download(format: "pdf" | "html") {
    if (!job || busy) return;
    B(true);
    E("");
    try {
      const r = await Taro.downloadFile({
        url:
          API_BASE_URL +
          `/api/miniapp/report-exports/${job.id}/download?format=${format}`,
        header: { authorization: "Bearer " + getShareholderToken() },
      });
      if (r.statusCode !== 200)
        throw new Error("下载失败、文件已过期或门店授权已变化，请重新生成");
      if (format === "pdf")
        await Taro.openDocument({
          filePath: r.tempFilePath,
          fileType: "pdf",
          showMenu: true,
        });
      else if (typeof Taro.shareFileMessage === "function")
        await Taro.shareFileMessage({
          filePath: r.tempFilePath,
          fileName: `${period}-财务报表.html`,
        });
      else {
        await Taro.saveFile({ tempFilePath: r.tempFilePath });
        await Taro.showModal({
          title: "HTML文件已保存",
          content: "当前微信环境不支持直接转发HTML，请更新微信后重试。",
          showCancel: false,
        });
      }
    } catch (e) {
      E(e instanceof Error ? e.message : "下载或打开失败");
    } finally {
      B(false);
    }
  }
  const waiting = !!job && ["pending", "running"].includes(job.status);
  return (
    <View className="page detail-page export-page">
      <Text className="eyebrow">文件与分享</Text>
      <Text className="detail-page-title">导出财务报表</Text>
      <View className="section export-intro">
        <Text className="export-month">{period.replace("-", "年")}月</Text>
        <Text className="section-title">完整经营报告</Text>
        <Text className="row-sub">
          包含经营指标、分类统计、支出明细、流水业务与凭证。
        </Text>
        <View className="export-formats">
          <View>
            <Text className="file-badge">PDF</Text>
            <Text>手机查看 / 保存转发</Text>
          </View>
          <View>
            <Text className="file-badge">HTML</Text>
            <Text>转发到电脑查看</Text>
          </View>
        </View>
      </View>
      {error && (
        <View className="section error">
          <Text>{error}</Text>
          {job && (
            <Button className="secondary-button" onClick={refresh}>
              重新查询进度
            </Button>
          )}
        </View>
      )}
      {job && (
        <View className="section export-state">
          <View
            className={
              job.status === "ready"
                ? "export-state-icon ready"
                : "export-state-icon"
            }
          >
            {job.status === "ready" ? "✓" : waiting ? "···" : "!"}
          </View>
          <Text className="empty-title">
            {job.status === "ready"
              ? "报表已准备好"
              : waiting
                ? "正在整理报表与凭证"
                : "暂时无法生成报表"}
          </Text>
          <Text className="empty-description">
            {job.status === "ready"
              ? "可打开PDF，或转发HTML到电脑查看"
              : waiting
                ? "凭证较多时需要一些时间，请稍候"
                : job.error || "请稍后重新生成"}
          </Text>
          {job.warnings.map((warning, index) => (
            <Text className="export-warning" key={index}>
              {warning}
            </Text>
          ))}
          {job.status === "ready" && (
            <>
              <Button disabled={busy} onClick={() => download("pdf")}>
                打开PDF报表
              </Button>
              <Button
                className="secondary-button"
                disabled={busy}
                onClick={() => download("html")}
              >
                转发HTML文件
              </Button>
            </>
          )}
        </View>
      )}
      <Button
        className={job ? "secondary-button" : ""}
        loading={busy && !job}
        disabled={busy || waiting}
        onClick={create}
      >
        {waiting ? "正在生成，请稍候" : job ? "重新生成报表" : "生成报表"}
      </Button>
      <Text className="export-footnote">
        文件生成后24小时内可下载；查看和转发前请确认接收人。
      </Text>
    </View>
  );
}
