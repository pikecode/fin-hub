# 登录认证第一阶段实现说明

生成时间：2026-08-29

## 1. 本阶段目标

本阶段先实现后台管理端的基础登录闭环：

- 管理员账号密码登录。
- 服务端签发 HTTP-only Cookie。
- 后台页面进入时检查当前会话。
- 退出登录清除 Cookie。

股东小程序授权尚未实现，应在小程序正式开放报表前单独设计。

当前后台写操作接口已要求登录态，允许 `admin`、`finance` 角色执行。报表读取接口要求后台会话或股东授权 token。

用户管理已实现基础后台能力，只有 `admin` 角色可以访问。支持新增用户、编辑姓名、调整角色、重置密码、启用和停用账号。

股东小程序授权已实现第一阶段能力：后台创建授权码并绑定可查看门店和到期时间，小程序用授权码换取 Bearer token，报表接口按授权门店过滤。未登录后台且未携带股东 token 的报表请求会返回 `401`。

## 2. API

路由前缀：`/api/auth`

接口：

- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`

用户管理接口：

- `GET /api/users`
- `POST /api/users`
- `PATCH /api/users/{user_id}`

股东授权接口：

- `POST /api/shareholder-auth/login`
- `GET /api/shareholder-grants`
- `POST /api/shareholder-grants`
- `PATCH /api/shareholder-grants/{grant_id}`

Cookie：

- 名称：`fin_hub_session`
- 类型：HTTP-only
- 有效期：12 小时

## 3. 数据表

新增表：

- `users`

字段：

- `id`
- `username`
- `display_name`
- `password_hash`
- `role`
- `status`
- `last_login_at`
- `created_at`
- `updated_at`

## 4. 密码与会话

当前实现：

- 密码使用 `pbkdf2_hmac(sha256)` 加盐哈希。
- 会话 token 使用 HMAC-SHA256 签名。
- token 只保存用户 ID 和过期时间。

生产前建议：

- `SECRET_KEY` 必须换成强随机值。
- Cookie 在 HTTPS 环境应设置 `secure=true`。
- 增加登录失败次数限制。
- 增加股东授权码轮换提醒。
- 管理员默认密码必须首登修改。

## 5. 默认开发账号

开发 seed 会创建：

```text
账号：admin
密码：admin123456
角色：admin
```

该账号仅用于本地开发和联调，不应用于生产环境。

## 6. 后台页面

新增：

- `/login`
- `/users`
- `/shareholder-grants`

已接入：

- `AppShell` 进入时请求 `/api/auth/me`。
- 未登录时跳转 `/login`。
- 顶栏显示当前用户名称。
- 顶栏支持退出登录。

## 7. 股东小程序

新增：

- `pages/shareholder-login/index`

流程：

- 输入后台发放的授权码。
- 调用 `/api/shareholder-auth/login` 换取 token。
- token 存入小程序本地 storage。
- 报表请求通过 `Authorization: Bearer <token>` 访问。
- 授权停用、授权到期或 token 失效时，服务端返回 `401`，小程序清除本地 token 并提示重新登录。

本地开发 seed 授权码：

```text
share123456
```
