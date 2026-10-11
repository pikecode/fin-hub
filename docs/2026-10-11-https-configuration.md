# HTTPS 配置

## 已配置

- 使用 Let’s Encrypt 免费证书，覆盖 `moshuo.fun`、`fin.moshuo.fun`。
- 证书路径：`/etc/letsencrypt/live/moshuo.fun/`，私钥仅保存在服务器，不进入仓库。
- 本次证书到期日期：2027-01-09。
- Certbot 使用 webroot 验证，目录 `/opt/fin-hub/infra/site/moshuo`。
- Nginx 只读挂载 `/etc/letsencrypt`，映射 443，支持 TLS 1.2 / 1.3。
- `certbot.timer` 已启用；成功续期后通过 deploy hook 检查并重新加载 Nginx。
- Hook 源文件：`infra/nginx/renewal-deploy-hook.sh`；服务器位置 `/etc/letsencrypt/renewal-hooks/deploy/fin-hub-nginx.sh`。
- 配置备份：`/opt/fin-hub/releases/config-20261011-https/`。
- `www.moshuo.fun` 未解析，未包含在证书中。

## 验证与公网限制

服务器内部 HTTPS 首页、登录页正常，证书信任校验与 TLS 1.3 握手通过。HTTP 首页、后台登录和 API 健康检查均为 200。

公网 443 连接超时，服务器 UFW 未启用。需要在阿里云安全组放行入方向 TCP 443（来源 `0.0.0.0/0`），然后再次检查公网 HTTPS。当前保留 HTTP，不强制跳转，以免影响访问。

放行并验证后，可将两个域名的 HTTP location / 改为 `return 301 https://$host$request_uri;`，保留 `/.well-known/acme-challenge/` 验证路径与 IP 访问配置。

## 运维

检查续期计划：`systemctl list-timers certbot.timer`。

测试续期与加载：`certbot renew --dry-run --run-deploy-hooks`。

模拟续期第一次访问 staging 服务超时；重试后完成账户注册，但验证机构第二次验证 `fin.moshuo.fun` 的 HTTP 80 连接超时，未通过。正式证书申请已成功，不影响当前证书使用。请确认安全组入方向 TCP 80 与 443 对 `0.0.0.0/0` 放行，随后重新测试续期。自动续期任务已启用，deploy hook 手动执行验证通过。

证书申请命令：`certbot certonly --webroot -w /opt/fin-hub/infra/site/moshuo --cert-name moshuo.fun -d moshuo.fun -d fin.moshuo.fun --non-interactive --agree-tos --register-unsafely-without-email`。账户暂未配置邮箱，后续可通过 `certbot update_account --email 实际邮箱` 添加。
