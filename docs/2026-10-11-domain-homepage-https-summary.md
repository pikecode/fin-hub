# 域名、品牌首页与 HTTPS 修改汇总

日期：2026-10-11。本文记录本次实际修改、部署和验证结果。

## 1. 域名与后台 API

将品牌首页与财务管理系统按域名分别提供服务：

| 入口 | 用途 | 当前状态 |
| --- | --- | --- |
| `http://moshuo.fun/` | 蘑说品牌首页 | 公网访问返回 200 |
| `http://fin.moshuo.fun/login` | 管理后台 | 已配置并验证 |
| `http://fin.moshuo.fun/api/` | 后台 API 路径 | 健康接口验证通过 |
| `https://moshuo.fun/` | 品牌首页 HTTPS | 服务器内部正常，公网 443 超时 |
| `https://fin.moshuo.fun/` | 管理后台 HTTPS | 服务器内部正常，公网 443 尚待放行验证 |
| `www.moshuo.fun` | 可选首页域名 | 未查询到解析，未纳入证书 |

后台前端使用同域相对路径 `/api`，无需另设 API 子域名，也无需因此重建前端。Nginx 将 `/api/` 转发到 API 容器 8000 端口，其余后台请求转发到前端容器 3000 端口。

服务器 `CORS_ORIGINS` 保留原 IP 地址，并加入 `http://fin.moshuo.fun`、`https://fin.moshuo.fun`。域名登录页、静态资源和 API 健康检查已验证。

## 2. 静态品牌首页

新增 `infra/site/moshuo/index.html`，采用暖白与森林绿配色，包含：

- 蘑说品牌标识、导航和介绍。
- “自然有味，生活有光”主视觉及内嵌 SVG 蘑菇插画。
- 自然、用心、相聚三个品牌理念介绍。
- 备案号 `粤ICP备2026152670号-1`，链接至 `https://beian.miit.gov.cn/`。
- 桌面和移动端响应式布局、键盘焦点样式、减少动态效果偏好支持。

页面无需构建，无外部字体、图片或脚本依赖。服务器源文件位于 `/opt/fin-hub/infra/site/moshuo/index.html`，通过 Nginx 静态目录直接提供。未执行浏览器截图验证。

## 3. HTTPS 与自动续期

通过 Certbot webroot 方式成功申请 Let’s Encrypt 免费证书，覆盖 `moshuo.fun` 和 `fin.moshuo.fun`。

| 配置项 | 实际配置 |
| --- | --- |
| 证书目录 | `/etc/letsencrypt/live/moshuo.fun/` |
| 证书文件 | `fullchain.pem` |
| 私钥文件 | `privkey.pem`，仅保存在服务器 |
| 本次有效期截止 | 2027-01-09 |
| 验证目录 | `/opt/fin-hub/infra/site/moshuo/.well-known/acme-challenge/` |
| HTTPS 协议 | TLS 1.2、TLS 1.3 |
| 自动续期 | `certbot.timer` 已启用 |
| 续期后操作 | 检查 Nginx 配置并重新加载 |

生产 Compose 增加 `443:443` 映射和 `/etc/letsencrypt` 只读挂载。Nginx 容器已重建，正式证书已加载。服务器内部 HTTPS 首页和后台登录返回 200，证书信任校验及 TLS 1.3 握手通过。

新增 `infra/nginx/renewal-deploy-hook.sh`，服务器安装位置为 `/etc/letsencrypt/renewal-hooks/deploy/fin-hub-nginx.sh`，权限 755。该 hook 手动执行验证通过。

账户暂未绑定邮箱，后续可通过 `certbot update_account --email 实际邮箱` 添加。

## 4. 公网访问问题与剩余工作

最新检查显示：

- `moshuo.fun` 正确解析至 `8.138.19.56`，未返回 AAAA 记录。
- 公网 HTTP 首页返回 200。
- 公网 HTTPS 连接 443 超时；直接指定服务器 IP 和域名进行 HTTPS 请求也超时，因此不是仅由本地 DNS 造成。
- Nginx 容器正常运行、配置检查通过，服务器监听 IPv4/IPv6 的 443 端口。
- 服务器 UFW 未启用，内部 HTTPS 请求返回 200。

上述证据表明 HTTPS 服务已配置，公网链路仍受阻；较可能是阿里云安全组未放行 443，尚未直接检查云控制台规则。

需要在当前实例绑定的阿里云安全组中添加入方向规则：TCP 443，来源 `0.0.0.0/0`，策略允许。同时确认 TCP 80 对公网放行，供证书 HTTP 验证使用。

自动续期模拟测试尚未通过：第一次访问 staging 服务超时，重试后验证机构对 `fin.moshuo.fun` 的第二次 HTTP 验证连接超时。该失败不影响已签发证书，但放行后需要重新执行模拟测试。

目前保留 HTTP，**未启用 HTTP 自动跳转 HTTPS**。公网 HTTPS 验证通过后再启用跳转，并保留 ACME 验证路径与原 IP 访问逻辑。

## 5. 文件与部署记录

| 文件 | 修改内容 |
| --- | --- |
| `infra/site/moshuo/index.html` | 新增品牌静态首页 |
| `infra/nginx/fin-hub.conf` | 首页与后台域名路由、证书配置、HTTPS 监听及验证路径 |
| `infra/docker/docker-compose.prod.images.yml` | 增加首页挂载、443 映射和证书挂载；服务器实际使用此文件 |
| `infra/docker/docker-compose.prod.yml` | 同步相应生产配置 |
| `infra/nginx/renewal-deploy-hook.sh` | 新增续期成功后的 Nginx 加载脚本 |

服务器配置备份目录：

- `/opt/fin-hub/releases/config-20261011-domain/`
- `/opt/fin-hub/releases/config-20261011-brand-site/`
- `/opt/fin-hub/releases/config-20261011-https/`

本次部署涉及 Nginx、静态文件和 API 域名白名单；未改动业务数据及其他应用服务。

## 6. 后续验证命令

```sh
curl -I https://moshuo.fun/
curl -I https://fin.moshuo.fun/login
curl https://fin.moshuo.fun/api/health

# 以下在服务器上执行
docker exec docker-nginx-1 nginx -t
systemctl list-timers certbot.timer
certbot renew --dry-run --run-deploy-hooks --no-random-sleep-on-renew
```

相关分项文档：

- [品牌静态首页](2026-10-11-moshuo-brand-homepage.md)
- [HTTPS 配置](2026-10-11-https-configuration.md)
