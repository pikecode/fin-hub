import { Button, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useState } from "react";
import type { Attachment } from "@fin-hub/shared-types";
import { api, API_BASE_URL, getShareholderToken } from "../../lib/api";
export default function Receipts() {
  const { type = "expense_item", id = "" } = Taro.useRouter().params;
  const [rows, R] = useState<Attachment[] | null>(null), [error,E]=useState(""), [retry,X]=useState(0);
  useEffect(()=>{let live=true;R(null);E("");api.recordAttachments(type,id).then(r=>{if(live)R(r)}).catch(e=>{if(live)E(e.message)});return()=>{live=false}},[type,id,retry]);
  async function open(a:Attachment) {
    try {
      const r=await Taro.downloadFile({url:API_BASE_URL+"/api/miniapp/attachments/"+a.id,header:{authorization:"Bearer "+getShareholderToken()}});
      if(r.statusCode!==200)throw new Error("凭证暂不可用或查看权限已变化");
      if(a.content_type?.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(a.file_name)) await Taro.previewImage({urls:[r.tempFilePath]});
      else await Taro.openDocument({filePath:r.tempFilePath,showMenu:true});
    } catch(e){Taro.showToast({title:e instanceof Error?e.message:"打开失败",icon:"none"})}
  }
  return <View className="page"><Text className="title">报表凭证</Text>{error?<View className="section"><Text>{error}</Text><Button onClick={()=>X(retry+1)}>重试</Button></View>:rows===null?<Text>正在加载…</Text>:!rows.length?<View className="section">暂无凭证</View>:rows.map(a=><View className="section" key={a.id}><Text>{a.file_name}</Text><Text className="row-sub">{a.content_type}</Text><Button onClick={()=>open(a)}>查看 / 保存凭证</Button></View>)}</View>
}
