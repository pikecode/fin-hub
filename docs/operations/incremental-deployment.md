# 增量部署操作流程

更新日期：2026-10-12。后续日常小改动默认按本文发布，只更新受影响服务。

## 1. 判断范围与基线

检查 `git status --short`、`git diff --stat` 和具体差异。纳入上次尚未部署的修改、共享包、新增、删除和重命名文件，不能只看当前需求。

| 修改范围 | 发布方式 |
| --- | --- |
| 前端页面、样式、交互 | 本地生产构建，上传运行产物，仅更新 admin-web |
| API 代码与校验逻辑 | 依赖不变时上传代码，封装轻量镜像，仅更新 api |
| 共享包 | 更新使用该包的服务以及对应编译产物 |
| 静态品牌首页 | 上传静态文件，无需构建和重启应用 |
| Nginx 配置 | 检查并重新加载；端口、挂载变化则只重建 nginx |
| 依赖、锁文件、基础镜像、构建配置 | 完整构建受影响服务 |
| 数据库结构 | 包含迁移文件，评估备份、兼容性及回滚限制 |

读取实际运行镜像和磁盘状态，不将历史标签当作当前基线：

```sh
ssh root@8.138.19.56 'docker inspect docker-api-1 docker-admin-web-1 --format "{{.Name}} {{.Config.Image}} {{.State.Status}}"'
ssh root@8.138.19.56 'df -h /'
```

每次使用独立标签，例如 `deploy-20261012-voucher-modal`，记录发布前后镜像、源码 commit、未提交改动和文件清单。仅在依赖不变、基线明确、差异完整时使用覆盖层。基线不确定或累计层过多时完整构建。

验证对应改动：前端类型检查和生产构建，后端相关接口测试。数据库测试使用隔离测试库，禁止在生产执行测试 fixture。

## 2. 前端小改动

TSX 必须经过生产构建。使用与服务器一致的 `linux/amd64` 环境，不直接发布 macOS native 依赖或构建产物。

本地基线镜像必须包含匹配的完整源码、依赖和 pnpm；只有运行产物的镜像不能直接作为源码构建基线。不满足时使用完整 Dockerfile 的缓存构建。

临时构建 Dockerfile 示例：

```dockerfile
FROM fin-hub-admin-web:<已确认的本地构建基线>
WORKDIR /repo
COPY apps/admin-web/app/finance/reconciliation/page.tsx apps/admin-web/app/finance/reconciliation/page.tsx
# 必须纳入其他变化文件；共享包变化时也复制对应源码。
RUN pnpm --filter @fin-hub/admin-web build
```

```sh
 docker build --platform linux/amd64 -f <临时Dockerfile> -t fin-hub-admin-web:<发布标签> .
```

构建结束且成功后才导出。构建期间不要修改本次源码。只改前端时不构建 API，不重新安装未变化的依赖。

创建临时容器，通过 docker cp 导出运行产物：

```sh
docker create --platform linux/amd64 --name <临时导出容器> fin-hub-admin-web:<发布标签>
docker cp <临时导出容器>:/repo/apps/admin-web/.next <本地产物目录>/
# 仅修改共享包时导出对应 dist。
docker cp <临时导出容器>:/repo/packages/shared-api-client/dist <本地产物目录>/shared-api-client-dist
```

每次导出完整 `.next`，排除 `.next/cache`。变化的 public 资源、Next 配置、其他运行文件和共享包 dist 也必须纳入清单。

服务器预建 `/opt/fin-hub/releases/<发布标签>`，压缩上传：

```sh
# macOS 屏蔽 Apple 元数据；Linux 按 tar 支持情况省去 --no-xattrs。
COPYFILE_DISABLE=1 tar --no-xattrs --exclude='.next/cache' -C <本地产物目录> -czf - .next shared-api-client-dist |
  ssh root@8.138.19.56 'tar -xzf - -C /opt/fin-hub/releases/<发布标签>'
```

未修改共享包时省去对应 dist 参数。最近前端运行产物压缩约 14 MB，实际大小取决于改动，避免上传包含依赖的数百 MB 完整镜像。

服务器以当前线上镜像封装新版本：

```dockerfile
FROM fin-hub-admin-web:<线上当前标签>
RUN rm -rf /repo/apps/admin-web/.next
COPY .next /repo/apps/admin-web/.next
# 仅共享包变化时加入；其他变化的运行文件同理。
COPY shared-api-client-dist /repo/packages/shared-api-client/dist
```

先删除旧 `.next` 再完整替换，防止 chunk 与构建版本混用。服务器 docker build 只做 COPY/轻量封装，不执行 pnpm build。生成镜像后仅更新 ADMIN_WEB_IMAGE 和 admin-web。

## 3. 后端、静态页与 Nginx

### 后端代码

Python 和系统依赖不变时，将全部修改文件上传 release 目录，以线上 API 镜像封装代码层：

```dockerfile
FROM fin-hub-api:<线上当前标签>
COPY schemas.py /app/app/schemas.py
COPY router.py /app/app/modules/expense/router.py
```

文件路径仅为示例。新增文件纳入，删除或重命名文件不能只覆盖。先验证镜像可导入模块，再仅更新 API_IMAGE 和 api。有依赖变化则完整构建。

有数据库迁移时包含迁移文件，评估备份与影响；API 启动会执行 alembic upgrade head。代码回滚不自动恢复数据库结构，不能默认安全 downgrade。

### 静态首页

只改 `infra/site/moshuo/` 时备份服务器文件，再上传到 `/opt/fin-hub/infra/site/moshuo/`。建议同目录临时文件上传完成后原子替换，避免读取未上传完整的 HTML。无需构建或重启前后端，检查页面、资源与备案链接。

### Nginx

备份配置，先用新配置、对应 Docker 网络和挂载运行 nginx -t，通过后更新实际配置并 reload。当前配置是单文件 bind mount，写入时保留被挂载文件 inode；直接 mv 替换宿主文件可能导致容器仍读取旧配置。端口、挂载变化则只重建 nginx。

## 4. 发布与验收

1. 备份 `/opt/fin-hub/.env.production` 到本次 release，备份权限设为 600，禁止打印密码、token、私钥。
2. 构建及镜像检查成功后，在 env 中持久化更新目标服务镜像项，保留其他配置。
3. 只启动目标服务，不全栈重启：

```sh
docker compose --env-file /opt/fin-hub/.env.production \
  -f /opt/fin-hub/infra/docker/docker-compose.prod.images.yml \
  up -d --no-deps admin-web
# 后端修改则改为 api。
docker exec docker-nginx-1 nginx -t
docker exec docker-nginx-1 nginx -s reload
```

应用容器地址可能变化，重新加载 Nginx 刷新代理解析。前后端契约同时变化时按兼容性安排发布顺序。不修改 PostgreSQL、Redis、文件卷或其他项目容器。

发布必需检查：

- 容器运行新镜像，状态正常，无异常重启。
- `https://fin.moshuo.fun/login` 返回 200。
- 从新登录页 HTML 提取 /_next/ JS/CSS 链接，逐个请求全部 200。
- 同域 /api/health 返回正常健康结果。
- 使用合法登录态验证本次接口和页面；写入测试优先本地，禁止随意修改生产业务数据。
- 有浏览器条件时检查交互和错误反馈；接口与静态资源检查不等于浏览器视觉验收。

多域名 Nginx 下，裸 `http://127.0.0.1/api/health` 可能命中品牌首页虚拟主机。内部检查应使用正确 Host：

```sh
curl -fsS -H 'Host: fin.moshuo.fun' http://127.0.0.1/api/health
curl -fsS https://fin.moshuo.fun/api/health
```

公网 HTTPS 被限制时明确报告限制，检查内部 TLS 和 HTTP，不能报告公网 HTTPS 成功。

## 5. 回滚、清理与完整构建

检查失败时停止继续切换，将目标服务镜像项恢复为发布前版本，同样服务级启动、reload Nginx 并重新检查。只恢复目标配置，避免整份旧 env 覆盖期间其他变更。静态文件与 Nginx 使用各自备份回滚，迁移单独评估。

完成后删除本次停止的导出容器与临时 Dockerfile，保留 release 清单、配置备份和可回滚镜像。不要每次全局 docker image prune -af，也不要删除其他项目资源。

依赖、基础镜像或构建配置变化，或者无法确定覆盖层完整性时，使用 [预构建镜像方案](prebuilt-image-deployment.md)。仍只更新受影响服务，服务器不承担前端源码构建。

本流程是人工执行标准，尚未实现自动识别改动并发布的统一脚本。旧 fast-deploy.sh 不作为本流程入口。源码完成与部署完成分别报告，验证结束才报告上线成功。
