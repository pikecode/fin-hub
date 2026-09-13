# 生产部署指南

本文档只保留当前推荐流程。

## 推荐流程

当前生产环境推荐使用**预构建镜像部署**，不要在服务器上执行前端或后端构建。

原因：

- 服务器资源有限。
- `admin-web` 的 Next.js 生产构建会占用较多 CPU、内存和磁盘 I/O。
- 预构建镜像可以把重活放到本地或 CI。

## 部署前提

- 服务器已配置 SSH。
- 服务器已初始化 `/opt/fin-hub`。
- 服务器已存在 `.env.production`。
- 本地可运行 Docker。

SSH 信息见 [server-ssh-access.md](server-ssh-access.md)。

## 一次性准备

确认本地有生产环境文件：

```bash
cp .env.production.example .env.production
```

`.env.production` 至少需要：

```text
POSTGRES_PASSWORD=...
SECRET_KEY=...
CORS_ORIGINS=https://your-domain.com
NEXT_PUBLIC_API_BASE_URL=https://your-domain.com/api
```

## 方式一：本地构建并上传镜像包

适合当前阶段。

构建并导出：

```bash
IMAGE_TAG=deploy-20260906-xxx scripts/build-prod-images.sh --save
```

输出文件：

```text
reports/deploy/fin-hub-images-<tag>.tar
reports/deploy/fin-hub-images-<tag>.env
```

上传到服务器：

```bash
scp reports/deploy/fin-hub-images-<tag>.tar fin-hub-server:/opt/fin-hub/
scp reports/deploy/fin-hub-images-<tag>.env fin-hub-server:/opt/fin-hub/
```

服务器加载并重启：

```bash
ssh fin-hub-server 'cd /opt/fin-hub && scripts/deploy-prod-images.sh --load fin-hub-images-<tag>.tar --image-env fin-hub-images-<tag>.env'
```

## 方式二：镜像仓库部署

如果后面接入镜像仓库，可直接发布：

```bash
scripts/build-prod-images.sh --registry ghcr.io/example/fin-hub --push
ssh fin-hub-server 'cd /opt/fin-hub && scripts/deploy-prod-images.sh'
```

对应 `.env.production`：

```text
IMAGE_TAG=<tag>
API_IMAGE=ghcr.io/example/fin-hub/fin-hub-api:<tag>
ADMIN_WEB_IMAGE=ghcr.io/example/fin-hub/fin-hub-admin-web:<tag>
```

## 服务器发布脚本

`scripts/deploy-prod-images.sh` 是线上正式入口。

它会：

- 读取 `.env.production`
- 可选 `docker load` 镜像包
- `docker compose up -d`
- 重建 `api`、`admin-web`

它**不会**在服务器上构建镜像。

## 兼容流程

旧脚本 `scripts/deploy-prod.sh`、`scripts/deploy-server.sh`、`scripts/deploy.sh`、`scripts/fast-deploy.sh` 仍然保留，但只适合作兼容或排障参考，不建议作为主流程。

## 验证

部署后检查：

```bash
ssh fin-hub-server 'cd /opt/fin-hub && docker compose --env-file .env.production -f infra/docker/docker-compose.prod.images.yml ps'
ssh fin-hub-server 'curl -fsS http://127.0.0.1/api/health'
```

浏览器可验证：

- `http://8.138.19.56/`
- `http://8.138.19.56/api/health`

## 常见问题

### 1. `Not authenticated`

接口需要登录态 cookie，通常是未登录或直接访问 API 直链。

### 2. `unexpected EOF`

镜像包未完整上传，重新 `scp` 后再 `docker load`。

### 3. 页面仍指向本地接口

检查前端是否使用了正确的线上域名和同域 `/api` 代理。
