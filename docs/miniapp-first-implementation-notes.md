# 小程序第一阶段实现说明

生成时间：2026-08-28

## 1. 本阶段目标

本阶段把股东小程序从静态展示推进到只读报表 API 联调状态。

小程序当前定位：

- 面向股东查看门店财务结果。
- 不开放做账、匹配、钉钉配置等管理能力。
- 只读取后端汇总后的报表数据。

## 2. 页面清单

### 2.1 授权门店

路径：`pages/stores/index`

数据来源：

- `GET /api/shareholder-auth/me`
- `GET /api/reports/store-summaries`
- `GET /api/reports/store-comparison`

当前能力：

- 校验本地股东 token，无 token 时跳转登录页。
- 展示当前股东授权名称和可查看门店数量。
- 展示可查看门店。
- 展示门店最近已封账账套的账期、封账状态、收入和利润。
- 展示授权范围内最新账期门店对比总收入、总利润和门店排名。
- 点击门店进入报表详情。
- 支持刷新。
- token 无效、授权停用或授权到期时清除登录态，提示重新登录并返回登录页。
- 支持退出登录。

### 2.2 门店报表

路径：`pages/report/index`

页面参数：

- `storeId`
- `period`

数据来源：

- `GET /api/reports/ledger-periods?store_id={storeId}`
- `GET /api/reports/ledger-trends?store_id={storeId}&limit=6`
- `GET /api/reports/ledger-detail?store_id={storeId}&period={period}`

当前能力：

- 展示门店名称。
- 展示账期和账套状态。
- 仅展示股东授权范围内已封账账套。
- 支持切换该门店可查看账期。
- 展示营业收入、支出合计、利润。
- 展示最近账期收入和利润趋势，并以条形图强化对比。
- 展示待处理支出数量和未匹配银行流水数量。
- 支持在收入、费用分类、供应商、待处理支出、未匹配流水之间切换查看。
- 支持复制当前账期报表摘要，并提供微信分享入口。
- 收入明细展示经营收入、实收金额和手续费。
- 待处理支出展示日期、供应商和付款状态。
- 未匹配银行流水展示方向、发生日期、已匹配金额和流水金额。

### 2.3 股东登录

路径：`pages/shareholder-login/index`

数据来源：

- `POST /api/shareholder-auth/login`

当前能力：

- 输入后台发放的授权码登录。
- 登录成功后保存股东 token。
- 登录失败显示授权码无效、已停用或已到期。

## 3. 小程序 API 访问

新增：

- `apps/shareholder-miniapp/src/lib/api.ts`

当前开发 API 地址：

```text
http://localhost:8000
```

构建时可通过环境变量覆盖：

```text
TARO_APP_API_BASE_URL=https://api.example.com pnpm --filter @fin-hub/shareholder-miniapp build
```

上线前需要配置为正式 HTTPS 域名，并在微信公众平台配置 request 合法域名。

## 4. 下一步建议

1. 增加授权码过期提醒和重新登录提示。
2. 增加股东端图表截图或正式 PDF 导出。
3. 增加多门店合并报表视图。
