# 预构建镜像部署方案

当前生产服务器资源有限，不适合在服务器上执行 `docker compose build`。尤其是 `admin-web` 的 Next.js 生产构建会下载 Node 依赖、构建页面、执行 lint/typecheck，容易把 SSH 和 HTTP 一起拖慢甚至卡死。

新的部署方式把发布拆成两步：

1. 在本地开发机或 CI 构建镜像。
2. 服务器只加载或拉取镜像，然后重启容器。

## 方式一：本地构建并上传镜像包

适合当前没有镜像仓库的阶段。

```bash
scripts/build-prod-images.sh --save
```

脚本会输出：

```text
reports/deploy/fin-hub-images-<tag>.tar
reports/deploy/fin-hub-images-<tag>.env
```

上传到服务器：

```bash
scp reports/deploy/fin-hub-images-<tag>.tar fin-hub-server:/opt/fin-hub/
scp reports/deploy/fin-hub-images-<tag>.env fin-hub-server:/opt/fin-hub/
```

在服务器发布：

```bash
ssh fin-hub-server 'cd /opt/fin-hub && scripts/deploy-prod-images.sh --load fin-hub-images-<tag>.tar --image-env fin-hub-images-<tag>.env'
```

## 方式二：镜像仓库发布

适合后续正式 CI/CD。

构建并推送：

```bash
scripts/build-prod-images.sh --registry ghcr.io/example/fin-hub --push
```

服务器 `.env.production` 配置本次镜像：

```text
IMAGE_TAG=<tag>
API_IMAGE=ghcr.io/example/fin-hub/fin-hub-api:<tag>
ADMIN_WEB_IMAGE=ghcr.io/example/fin-hub/fin-hub-admin-web:<tag>
```

服务器发布：

```bash
ssh fin-hub-server 'cd /opt/fin-hub && scripts/deploy-prod-images.sh'
```

## 注意事项

- `scripts/deploy-prod-images.sh` 不会 build 镜像。
- API 容器启动时仍会执行 `alembic upgrade head`。
- `NEXT_PUBLIC_API_BASE_URL` 是前端构建时变量，构建镜像前要确保 `.env.production` 中配置正确。
- 生产镜像建议使用 git SHA 或版本号作为 tag，避免只用 `latest` 导致无法回滚。
- 旧脚本 `scripts/deploy-prod.sh` 会在服务器 build，仅作为兼容方案保留。
