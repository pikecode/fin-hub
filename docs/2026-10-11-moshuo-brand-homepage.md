# 蘑说品牌静态首页

## 页面与部署

- 域名：`moshuo.fun`，兼容 `www.moshuo.fun`。
- 源文件：`infra/site/moshuo/index.html`，独立静态页面，无构建步骤、外部字体或脚本依赖。
- 暖白与森林绿配色，响应式布局，内嵌 SVG 品牌插画，展示品牌理念。
- 页脚展示用户提供的备案号 `粤ICP备2026152670号-1`，链接 `https://beian.miit.gov.cn/`。
- Nginx 按域名区分品牌首页与 `fin.moshuo.fun` 管理后台；生产 Compose 增加只读目录挂载。
- 服务器目录：`/opt/fin-hub/infra/site/moshuo`。
- 部署前配置备份：`/opt/fin-hub/releases/config-20261011-brand-site/`。

## 验证结果与待配置项

- Nginx 配置语法检查通过。
- 在服务器上通过 Host 请求验证：品牌首页、www 首页、后台登录页和 API 健康检查均返回 200；首页备案号存在。
- 初次部署时公共 DNS 查询未返回主域名 A 记录；后续检查已解析至 `8.138.19.56`，公网 HTTP 首页返回 200。www 尚未解析。
- HTTPS 证书及服务器 443 已配置，内部验证正常，但公网 443 超时，尚需确认云安全组放行。详见 [HTTPS 配置](2026-10-11-https-configuration.md)。
- 本次未执行浏览器截图验证。

## 后续更新

更新服务器静态 HTML 文件即可生效，不需要重建管理后台或 API。Nginx 配置或目录挂载变更后需检查配置并重新加载或重建 Nginx 容器。
