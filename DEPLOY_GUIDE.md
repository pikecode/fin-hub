# 🚀 fin-hub 部署指南 - 优化版

## 快速开始（3 步）

### 1️⃣ 登录 Docker Hub（第一次需要）

```bash
docker login
# 输入你的 Docker Hub 用户名和密码
```

### 2️⃣ 部署（一行命令）

```bash
./scripts/deploy.sh
```

### 3️⃣ 完成！

整个部署过程：
- **第1次**：10-15 分钟（构建 + 推送 + 拉取）
- **后续**：5-7 分钟（缓存生效）

---

## 📋 常用命令

### 基础部署

```bash
# 部署到默认服务器 (fin-hub-server)
./scripts/deploy.sh

# 部署到指定服务器
./scripts/deploy.sh prod-server

# 部署指定版本
./scripts/deploy.sh prod-server v1.0.0
```

### 高级用法

```bash
# 使用 fast-deploy.sh 获得完整信息
./scripts/fast-deploy.sh my-username v1.0.0 my-server

# 查看部署帮助
./scripts/fast-deploy.sh --help
```

### 部署后操作

```bash
# 查看实时日志
ssh fin-hub-server 'docker compose -f infra/docker/docker-compose.prod.images.yml logs -f api'

# 查看服务状态
ssh fin-hub-server 'docker compose -f infra/docker/docker-compose.prod.images.yml ps'

# 查看 API 健康状态
ssh fin-hub-server 'curl -s http://localhost:8000/health | jq'

# 进入容器调试
ssh fin-hub-server 'docker compose -f infra/docker/docker-compose.prod.images.yml exec api bash'
```

---

## 🔄 工作流程

### 日常开发 → 部署

```bash
# 1. 本地开发
vim apps/api/app/main.py
vim apps/admin-web/app/page.tsx

# 2. 本地测试
pnpm dev      # 或 scripts/dev-api-postgres.sh

# 3. 提交代码
git add .
git commit -m "feat: 新功能"
git push origin main

# 4. 一键部署
./scripts/deploy.sh

# 5. 检查效果
ssh fin-hub-server 'docker compose logs -f api'
```

### 快速回滚

```bash
# 如果新版本有问题，回到上一个版本
git log --oneline | head -5  # 查看历史版本

# 回滚到 a1b2c3d
./scripts/deploy.sh fin-hub-server a1b2c3d

# 完成！30 秒内切回到上一个版本
```

---

## 📊 性能数据

### 部署耗时分解

| 步骤 | 第1次 | 后续 | 说明 |
|---|---|---|---|
| 本地构建 | 8-10 min | 2-3 min | BuildKit + 缓存 |
| 推送镜像 | 2-3 min | <1 min | 增量上传 |
| 服务器拉取 | 1-2 min | <30 sec | Docker 缓存 |
| 启动服务 | 1-2 min | 1-2 min | 固定开销 |
| **总计** | **12-17 min** | **5-7 min** | **2-3x 加速** |

### 镜像大小

```
fin-hub-api:latest          180 MB
fin-hub-admin-web:latest    250 MB
────────────────────────────
总大小                      430 MB

Docker Hub 层级缓存后：
第1次推送                   430 MB
第2次推送                   5-50 MB（只推变化部分）
```

---

## 🔧 故障排查

### 部署失败：Docker login 失败

```bash
# 检查 Docker 是否运行
docker ps

# 检查登录状态
docker info | grep -i username

# 重新登录
docker logout
docker login
```

### 部署失败：无法连接服务器

```bash
# 检查 SSH 连接
ssh fin-hub-server 'hostname'

# 检查服务器文件
ssh fin-hub-server 'ls -la /opt/fin-hub/'

# 检查 .env.production
ssh fin-hub-server 'test -f /opt/fin-hub/.env.production && echo "✅ 存在" || echo "❌ 不存在"'
```

### 部署失败：API 启动异常

```bash
# 查看详细日志
ssh fin-hub-server 'docker compose -f infra/docker/docker-compose.prod.images.yml logs api'

# 检查数据库连接
ssh fin-hub-server 'docker compose exec api python -c "from app.core.database import engine; print(engine)"'

# 检查磁盘空间
ssh fin-hub-server 'df -h'
```

---

## 🛠️ 环境配置

### 服务器初始化（一次性）

```bash
# 1. 登录服务器
ssh fin-hub-server

# 2. 创建应用目录
mkdir -p /opt/fin-hub
cd /opt/fin-hub

# 3. 克隆代码
git clone https://github.com/your-repo/fin-hub.git .

# 4. 创建 .env.production（复制模板）
cp .env.example .env.production

# 5. 编辑配置
nano .env.production  # 改这些值：
#   POSTGRES_PASSWORD=strong-password
#   SECRET_KEY=your-32-char-secret
#   CORS_ORIGINS=https://your-domain.com
#   NEXT_PUBLIC_API_BASE_URL=https://your-domain.com/api

# 6. 验证 Docker 可用
docker ps

# 7. 完成！
exit
```

### .env.production 最小配置

```bash
# 必需：数据库
POSTGRES_PASSWORD=your-strong-password-here
DATABASE_URL=postgresql+psycopg://finhub:${POSTGRES_PASSWORD}@postgres:5432/finhub

# 必需：应用安全
SECRET_KEY=your-min-32-chars-strong-secret-key-12345  # 至少 32 字符
APP_ENV=production

# 必需：跨域配置
CORS_ORIGINS=https://your-domain.com,https://www.your-domain.com

# 必需：前端 API 地址
NEXT_PUBLIC_API_BASE_URL=https://your-domain.com/api

# 可选：钉钉集成
DINGTALK_SYNC_MODE=real
DINGTALK_APP_KEY=your-key
DINGTALK_APP_SECRET=your-secret
DINGTALK_DRIVE_UNION_ID=your-union-id
```

---

## 🔐 安全检查清单

部署前确认：

- [ ] 不在代码中提交密钥
- [ ] `.env.production` 不在 git 中（已在 .gitignore）
- [ ] `SECRET_KEY` 长度 ≥ 32 字符
- [ ] `CORS_ORIGINS` 不包含 localhost
- [ ] 后台管理员默认密码已改（admin/admin123456 → 新密码）
- [ ] 钉钉模式改为 `real`（如使用钉钉）

---

## 📈 监控部署

### 实时监控

```bash
# 在一个终端查看日志
ssh fin-hub-server 'watch -n 1 "docker compose -f infra/docker/docker-compose.prod.images.yml ps"'

# 在另一个终端查看应用日志
ssh fin-hub-server 'docker compose -f infra/docker/docker-compose.prod.images.yml logs -f --tail=50'
```

### 健康检查

```bash
# 检查 API 健康状态
curl -s https://your-domain.com/api/health | jq

# 检查 Postgres 连接
curl -s https://your-domain.com/api/system/readiness | jq

# 检查前端是否可访问
curl -I https://your-domain.com/
```

---

## 🚀 优化建议

### 加快后续部署

```bash
# 第1次部署后，后续使用缓存会很快
# 关键是不要清理本地 Docker 缓存

# ✅ 推荐：保留缓存
docker system df  # 查看缓存大小

# ❌ 避免：清理缓存
docker system prune -a  # 这会删除缓存
```

### 版本管理

```bash
# 使用语义化版本
./scripts/deploy.sh fin-hub-server v1.0.0
./scripts/deploy.sh fin-hub-server v1.0.1
./scripts/deploy.sh fin-hub-server v1.1.0

# 使用日期标记
./scripts/deploy.sh fin-hub-server $(date +%Y%m%d)

# 自动使用 git commit SHA（默认）
./scripts/deploy.sh
```

---

## 📚 更多信息

### 查看部署脚本源代码

```bash
cat scripts/deploy.sh        # 简化版（推荐）
cat scripts/fast-deploy.sh   # 完整版（高级）
```

### 查看 Docker 相关文档

- [预构建镜像部署方案](docs/prebuilt-image-deployment.md)
- [技术栈决策](docs/technical-stack-decision.md)
- [Dockerfile 优化](apps/admin-web/Dockerfile)

---

## 💡 常见问题

### Q: 部署需要多长时间？

A: 
- 第1次：12-17 分钟
- 后续：5-7 分钟（缓存生效）
- 只改代码：2-3 分钟（前面两步跳过）

### Q: 如何回滚到上一个版本？

A: 
```bash
# 查看历史版本
git log --oneline -5

# 回滚到任意版本
./scripts/deploy.sh fin-hub-server <commit-sha>
```

### Q: 能不能跳过某个步骤？

A:
```bash
# 仅推送代码（不构建镜像）
# 适用于只改配置的情况
ssh fin-hub-server 'cd /opt/fin-hub && git pull && docker compose up -d'

# 仅构建不部署
export DOCKER_BUILDKIT=1
scripts/build-prod-images.sh --registry docker.io/ompeak/fin-hub --push

# 仅部署已有镜像
ssh fin-hub-server 'cd /opt/fin-hub && docker compose pull && docker compose up -d'
```

### Q: 如何监控部署进度？

A:
```bash
# 部署中查看日志
ssh fin-hub-server 'docker compose logs -f api'

# 查看镜像拉取进度
ssh fin-hub-server 'docker compose pull -q api'

# 查看容器启动日志
ssh fin-hub-server 'docker compose up --no-start && docker compose logs api'
```

---

## 📞 遇到问题？

1. 检查服务器日志：`ssh fin-hub-server 'docker compose logs api'`
2. 查看部署脚本输出
3. 运行诊断：`scripts/export-diagnostics.sh`
4. 查看完整文档：`docs/`

---

**现在就开始部署：`./scripts/deploy.sh`** 🚀
