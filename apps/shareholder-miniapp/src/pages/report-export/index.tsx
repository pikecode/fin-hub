import { Button, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useState } from "react";
import { API_BASE_URL, getShareholderToken, request } from "../../lib/api";
interface Job { id:string;status:string;error?:string;warnings:string[];expires_at:string; }
export default function ExportPage(){
 const {storeId="",period=""}=Taro.useRouter().params;
 const [job,J]=useState<Job|null>(null),[busy,B]=useState(false),[error,E]=useState("");
 async function create(){if(busy)return;B(true);E("");try{J(await request<Job>("/report-exports",{store_id:storeId,period}));}catch(e){E(e instanceof Error?e.message:"生成失败")}finally{B(false)}}
 useEffect(()=>{if(!job||!["pending","running"].includes(job.status))return;let live=true;const timer=setTimeout(()=>{request<Job>("/report-exports/"+job.id).then(r=>{if(live){J(r);E("")}}).catch(e=>{if(live)E(e.message)})},2000);return()=>{live=false;clearTimeout(timer)}},[job]);
 async function refresh(){if(!job)return;try{J(await request<Job>("/report-exports/"+job.id));E("")}catch(e){E(e instanceof Error?e.message:"查询失败")}}
 async function download(format:"pdf"|"html") {if(!job||busy)return;B(true);E("");try{
   const r=await Taro.downloadFile({url:API_BASE_URL+`/api/miniapp/report-exports/${job.id}/download?format=${format}`,header:{authorization:"Bearer "+getShareholderToken()}});
   if(r.statusCode!==200)throw new Error("下载失败、文件已过期或门店授权已变化，请重新生成");
   if(format==="pdf")await Taro.openDocument({filePath:r.tempFilePath,fileType:"pdf",showMenu:true});
   else if(typeof Taro.shareFileMessage==="function")await Taro.shareFileMessage({filePath:r.tempFilePath,fileName:`${period}-财务报表.html`});
   else {await Taro.saveFile({tempFilePath:r.tempFilePath});await Taro.showModal({title:"HTML文件已保存",content:"当前微信环境不支持直接转发HTML，请更新微信后重试。",showCancel:false})}
 }catch(e){E(e instanceof Error?e.message:"下载或打开失败")}finally{B(false)}}
 return <View className="page"><Text className="title">导出财务报表</Text><View className="section"><Text>{period} · 同一快照生成HTML和PDF</Text><Text className="row-sub">包含PC报表指标、分类统计、支出明细、流水业务附录与凭证。文件24小时内有效，下载时仍校验门店权限。</Text><Text className="row-sub">PDF可在微信打开并通过菜单保存/转发；HTML用于保存或转发到电脑查看。</Text></View>{error&&<View className="section error"><Text>{error}</Text>{job&&<Button onClick={refresh}>重查任务状态</Button>}</View>}{job&&<View className="section"><Text>{job.status==="ready"?"生成完成":job.status==="pending"?"等待生成":job.status==="running"?"正在生成，凭证较多时需要更长时间":job.error||"任务已失效，请重新生成"}</Text>{job.warnings.map((w,i)=><Text className="row-sub" key={i}>{w}</Text>)}{job.status==="ready"&&<><Button disabled={busy} onClick={()=>download("pdf")}>下载 / 打开PDF</Button><Button disabled={busy} onClick={()=>download("html")}>下载 / 转发HTML</Button></>}</View>}<Button loading={busy} disabled={busy||!!job&&["pending","running"].includes(job.status)} onClick={create}>{job?"重新生成":"生成报表文件"}</Button></View>
}
