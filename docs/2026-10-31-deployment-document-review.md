# 部署文档审查与流程优化

- 时间：2026-10-31 23:47（Asia/Shanghai）
- 耗时：约 30 分钟
- 类型：优化 / 部署 / 运维

## 内容

- 重新审查生产部署相关文档和脚本。
- 明确 `production-deployment.md` 为生产部署总入口。
- 增加变更类型决策表，区分增量部署和完整预构建镜像部署。
- 增加 SSH、HTTP、内存、磁盘和 Docker 状态预检。
- 明确生产服务器禁止执行源码构建、依赖安装和 Next.js 构建。
- 明确前端产物排除 `.next/cache`，只重启受影响服务。
- 修正旧镜像清理默认值为关闭，保留回滚镜像。
- 更新验收文档中的本地开发端口。
- 将安全的发布脚本同步到服务器，未重启生产容器。

## 验证

- `bash -n scripts/deploy-prod-images.sh scripts/build-prod-images.sh` 通过。
- `git diff --check` 通过。
- 服务器发布脚本确认 `PRUNE_OLD_IMAGES=false`。
- 生产容器状态正常，PostgreSQL healthy。
- 线上 API 健康检查和管理端静态资源检查通过。

## 回滚或注意事项

- 后续生产发布从 [生产部署指南](operations/production-deployment.md) 开始。
- 日常页面改动使用 [增量部署流程](operations/incremental-deployment.md)。
- 完整镜像构建只在本地或 CI 执行，服务器不承担前端构建。
