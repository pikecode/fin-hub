# 生产部署指南

更新日期：2026-10-31。

本文是生产部署总入口。日常发布必须先按下面的决策选择流程，再进入对应文档；不能直接调用旧部署脚本。

## 默认流程

后续日常发布默认使用 [增量部署操作流程](incremental-deployment.md)：按修改范围，只更新受影响服务。前端在本地或 CI 生产构建，上传运行产物；后端依赖不变时封装代码层；静态首页直接上传；Nginx 检查后重新加载。

前端弹窗、样式等小改动只更新 admin-web，不构建或重启 API；依赖、锁文件、基础镜像变化时完整构建受影响服务，见 [预构建镜像方案](prebuilt-image-deployment.md)。

## 发布决策

| 变更 | 唯一流程 |
| --- | --- |
| 前端页面、样式、交互 | [增量部署操作流程](incremental-deployment.md)，本地构建，服务器只封装并切换 `admin-web` |
| API 代码且依赖不变 | [增量部署操作流程](incremental-deployment.md)，服务器只封装并切换 `api` |
| 依赖、锁文件、基础镜像或构建配置 | [预构建镜像部署方案](prebuilt-image-deployment.md)，本地/CI 构建 `linux/amd64` 镜像 |
| 数据库迁移 | 先评估备份、兼容性和回滚，再按受影响服务发布 |

无论哪种流程，生产服务器都不执行源码构建、依赖安装或完整 Compose 构建。

## 生产环境

- SSH：root@8.138.19.56，或配置好的 fin-hub-server 别名。
- 项目目录：/opt/fin-hub。
- 环境文件：/opt/fin-hub/.env.production，仅更新目标服务镜像项，禁止输出秘密值。
- Compose：infra/docker/docker-compose.prod.images.yml。
- 后台：https://fin.moshuo.fun。
- API：同域 /api，无需单独域名或前端构建时绝对接口地址。
- 品牌首页：moshuo.fun，文件位于 infra/site/moshuo/。

发布前读取容器实际镜像作为基线，备份配置并记录源码版本。服务器只执行轻量镜像封装和启动，不执行前端源码构建或安装依赖。验证失败则处理或回滚，不报告上线成功。

## 脚本适用范围

scripts/deploy-prod-images.sh 仅用于完整预构建镜像发布，不是日常增量发布入口。它会执行全栈 Compose 操作；日常小改动不得使用它。完整发布时设置 `PRUNE_OLD_IMAGES=false` 保留回滚镜像，镜像清理独立安排。

旧 deploy.sh、fast-deploy.sh、deploy-prod.sh 等保留作参考，不作为日常小改动默认入口。

## 验证入口

```sh
curl -fsS https://fin.moshuo.fun/api/health
curl -fsS -o /dev/null https://fin.moshuo.fun/login
```

内部检查须加 Host：`curl -fsS -H 'Host: fin.moshuo.fun' http://127.0.0.1/api/health`。裸 127.0.0.1 可能命中品牌首页，不能据此判定 API 故障。

详细构建、上传、服务切换、静态资源检查与回滚步骤见 [增量部署操作流程](incremental-deployment.md)。
