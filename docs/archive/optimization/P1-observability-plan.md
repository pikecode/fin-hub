# P1 可观测性增强实施计划

**开始日期**: 2026-09-02  
**预计工时**: 13-17 小时  
**目标评分**: 9.2 → 9.4/10

---

## 🎯 优化目标

### 当前问题
- 基础日志，缺少结构化
- 无错误聚合和追踪
- 无性能监控指标
- 无业务指标看板
- 故障排查困难

### 目标成果
- ✅ Sentry 错误追踪和告警
- ✅ 应用性能监控（APM）
- ✅ 结构化日志
- ✅ 业务指标收集
- ✅ 健康检查增强

---

## 📋 实施计划

### 阶段 1：错误追踪（4-5 小时）

**1.1 集成 Sentry**
- 安装 Sentry SDK
- 配置 DSN 和环境
- 添加用户上下文
- 配置错误采样

**1.2 前端错误追踪**
- Next.js 错误边界
- API 调用错误捕获
- 用户操作上下文

**1.3 后端错误追踪**
- FastAPI 中间件集成
- 数据库错误捕获
- 任务队列错误

### 阶段 2：结构化日志（3-4 小时）

**2.1 Python 结构化日志**
- 使用 structlog
- JSON 格式输出
- 请求 ID 追踪
- 性能日志

**2.2 日志分级和过滤**
- DEBUG/INFO/WARNING/ERROR
- 敏感信息脱敏
- 日志轮转

**2.3 前端日志**
- 控制台日志格式化
- 关键操作日志
- 错误日志上报

### 阶段 3：健康检查增强（2-3 小时）

**3.1 详细健康检查**
- 数据库连接池状态
- Redis 连接状态
- 磁盘空间检查
- 依赖服务检查

**3.2 就绪检查**
- 数据库迁移状态
- 必需配置检查
- 外部服务可用性

**3.3 性能指标端点**
- 响应时间统计
- 请求计数
- 错误率

### 阶段 4：业务指标（4-5 小时）

**4.1 关键业务指标**
- 每日匹配笔数
- 未匹配流水数量
- 待处理事项统计
- 钉钉同步成功率

**4.2 实时监控端点**
- /api/metrics/dashboard
- /api/metrics/operations
- /api/metrics/performance

**4.3 简单可视化**
- 管理后台监控页面
- 关键指标卡片
- 趋势图表

---

## 🔧 技术方案

### Sentry 集成

**后端（FastAPI）**:
```python
import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.sqlalchemy import SqlalchemyIntegration

sentry_sdk.init(
    dsn=settings.sentry_dsn,
    environment=settings.app_env,
    traces_sample_rate=0.1,  # 10% 性能追踪
    profiles_sample_rate=0.1,
    integrations=[
        FastApiIntegration(),
        SqlalchemyIntegration(),
    ],
)
```

**前端（Next.js）**:
```typescript
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
});
```

### 结构化日志

```python
import structlog

logger = structlog.get_logger()

logger.info(
    "bank_transaction_created",
    transaction_id=transaction.id,
    store_id=transaction.store_id,
    amount=float(transaction.amount),
    direction=transaction.direction,
    user_id=current_user.id,
)
```

### 健康检查增强

```python
@router.get("/health/detailed")
async def detailed_health(db: Session = Depends(get_session)):
    checks = {
        "database": check_database(db),
        "redis": check_redis(),
        "disk": check_disk_space(),
        "migrations": check_migrations(db),
    }
    
    all_healthy = all(c["status"] == "healthy" for c in checks.values())
    
    return {
        "status": "healthy" if all_healthy else "degraded",
        "checks": checks,
        "timestamp": datetime.utcnow().isoformat(),
    }
```

### 业务指标收集

```python
@router.get("/metrics/dashboard")
async def dashboard_metrics(db: Session = Depends(get_session)):
    return {
        "pending_matches": count_pending_matches(db),
        "unmatched_transactions": count_unmatched_transactions(db),
        "today_matches": count_today_matches(db),
        "sync_success_rate": calculate_sync_success_rate(db),
        "avg_response_time": get_avg_response_time(),
    }
```

---

## 📊 预期成果

### 错误追踪
- 实时错误通知（Slack/Email）
- 错误聚合和去重
- 错误趋势分析
- 用户影响评估

### 日志分析
- 结构化查询
- 快速问题定位
- 性能瓶颈识别
- 用户行为追踪

### 健康监控
- 服务可用性监控
- 依赖服务状态
- 资源使用情况
- 自动告警

### 业务洞察
- 关键指标实时显示
- 业务异常快速发现
- 运营数据支持
- 趋势分析

---

## 🚀 实施步骤

### Step 1: 安装依赖
```bash
# 后端
cd apps/api
uv add sentry-sdk structlog

# 前端
cd apps/admin-web
pnpm add @sentry/nextjs
```

### Step 2: 配置环境变量
```bash
# .env
SENTRY_DSN=https://xxx@sentry.io/xxx
SENTRY_ENVIRONMENT=production
LOG_LEVEL=INFO
```

### Step 3: 实施集成
- Sentry 中间件
- 结构化日志
- 健康检查
- 业务指标

### Step 4: 验证测试
- 触发测试错误
- 检查 Sentry 收到
- 验证日志格式
- 测试健康检查

---

## 📈 成功指标

| 指标 | 当前 | 目标 |
|-----|------|------|
| 错误发现时间 | 用户报告 | < 5 分钟 |
| 故障定位时间 | 小时级 | 分钟级 |
| 日志查询效率 | 困难 | 秒级查询 |
| 系统可观测性评分 | 7.0/10 | 9.0/10 |

---

## 💰 投资回报

**投入**: 13-17 小时  
**产出**:
- 错误自动发现和告警
- 故障定位时间减少 80%
- 业务异常快速响应
- 运维效率提升 60%

**ROI**: ⭐⭐⭐⭐⭐

---

**下一步**: 开始实施阶段 1 - Sentry 错误追踪
