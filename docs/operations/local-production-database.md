# 本地连接生产数据库

本项目支持本地 API 通过 SSH 隧道连接生产环境的 PostgreSQL 和 Redis。

## 前置条件

- 已配置 `fin-hub-server` SSH 别名。
- 本地可以执行 `ssh fin-hub-server`。
- 服务器生产环境仍运行 PostgreSQL 和 Redis。

## 启动本地 API

使用专用脚本：

```bash
pnpm dev:api:production
```

脚本会自动：

- 建立 SSH 隧道。
- 从服务器读取数据库密码，仅用于当前进程，不写入本地文件。
- 连接服务器生产 PostgreSQL 和 Redis。
- 启动本地 API，端口为 `8057`。

本地管理端另开终端启动：

```bash
pnpm dev:admin
```

管理端地址：`http://localhost:3077`

## 连接地址

| 服务 | 服务器回环端口 | 本地隧道端口 |
| --- | ---: | ---: |
| PostgreSQL | `15432` | `15432` |
| Redis | `16379` | `16379` |

如需手动建立隧道：

```bash
ssh -N \
  -L 15432:127.0.0.1:15432 \
  -L 16379:127.0.0.1:16379 \
  fin-hub-server
```

## 注意事项

不要使用普通的 `pnpm dev` 连接生产库。该流程会执行开发数据初始化，可能写入生产数据库。

生产数据库端口只绑定服务器 `127.0.0.1`，不直接暴露公网；本地访问必须经过 SSH 隧道。
