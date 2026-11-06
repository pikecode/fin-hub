# Docker 镜像精简与本地空间清理

## 问题与修改

本地 fin-hub-admin-web 历史镜像出现重复 build 层：最新旧镜像的 history 含 17 次前端构建，共 131 条历史指令。镜像统计存在压缩、平台、共享层口径差异，不能将各标签 SIZE 相加。现有仓库 Dockerfile 本来已多阶段构建，未确认产生历史叠加的具体临时构建脚本。

此次启用 Next.js standalone，保留 monorepo 的 outputFileTracingRoot；运行阶段固定从 node:22-slim 开始，不再继承 NODE_BASE_IMAGE 参数，避免将旧应用镜像的历史层带入最终运行镜像。最终仅复制 standalone 与 .next/static，以 node 用户执行 apps/admin-web/server.js。当前应用没有 public 目录；未来增加 public 时，需显式复制到运行镜像 apps/admin-web/public。

官方依据：https://nextjs.org/docs/app/api-reference/config/next-config-js/output

## 本地验证

镜像 fin-hub-admin-web:clean-20261105 为 linux/arm64，本地完整生产构建通过（包含类型检查）。最终应用 COPY 层约 86MB，inspect 报告 Size=101108040 字节；不同 Docker 输出口径不可直接横比。最终镜像有 8 个文件系统层，无历史重复 build 层。

通过临时容器检查首页、登录、dashboard、bank、finance/reconciliation、finance/revenue-reconciliation、icon.svg，以及抽样 CSS/JS 资源，均 HTTP 200。/finance 本身无 page，404 符合目录结构。仅为页面和资源 smoke test，未验证登录、数据库和真实业务操作。

amd64 构建尝试因 auth.docker.io 连接超时失败，未产生可用新版本；不要将 arm64 本地验证结果视为 amd64 发布验证。本次没有推送或部署远端。

## 清理范围与回滚

仅清理本机 fin-hub-admin-web 和 fin-hub-api 中的历史标签，保留最近两版旧镜像及新精简镜像。未删除数据库卷、容器或其他项目镜像。移除的历史标签与原镜像信息记录在 Documents/docker-image-cleanup-20261105-225402。

保留前端回滚标签：build-20261105-finance-update、build-20261104-accrual-report。
保留 API 回滚标签：deploy-20261031-bank-period、deploy-20261007-dividend。

旧回滚镜像仍会引用部分历史层，不能期待本次清理回收全部共享层。后续确认新镜像适用于目标平台并完成业务验证后，再决定是否进一步减少旧版本。

## 后续构建约束

从 Node 基础镜像进行全量多阶段构建；不要 FROM 前一版 fin-hub-admin-web 再追加 COPY/RUN。使用相同构建上下文与缓存来加速，而不是把旧应用镜像当基础镜像。不要将数据库卷作为镜像清理对象。

## 最终结果

移除 158 个历史标签；清理后镜像统计从 197 降到 46（标签、平台和 image ID 的口径不相同，不应把两个差值等同）。实际执行的是 Buildx prune --all，未执行全局 image prune：该命令报告 48.21GB，清理后构建缓存为 0。

Docker 目录由约 133GiB 降至 57GiB，数据卷保留 54 个、原有容器保留 10 个（验证临时容器已移除），宿主机可用空间约 219GiB。清理前约 142GiB，可用净增约 77GiB，包含后台回收和构建过程影响。
