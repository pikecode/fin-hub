# 审批单重建运行手册

## 目的

把已经同步过但展示/绑定不正确的审批单派生数据清理掉，再按新逻辑重跑同步。

## 保留数据

- 门店
- 门店分组
- 用户/角色/权限
- 钉钉部门
- 钉钉审批模板
- 钉钉配置

## 清理数据

- `approval_instances`
- `expense_items`
- `attachments`
- `expense_bank_matches`
- 钉钉审批同步 `sync_jobs`

## 重建脚本

位置：`apps/api/scripts/reset-sync-data.py`

默认重建模式：

```bash
cd apps/api
DATABASE_URL="postgresql+psycopg://finhub:finhub@localhost:5432/finhub" \
  .venv/bin/python scripts/reset-sync-data.py \
  --scope approval-rebuild \
  --execute \
  --yes-i-know-this-deletes-data
```

## 重建步骤

1. 先确认后端已切到新同步逻辑
2. 执行重建脚本
3. 重新跑钉钉审批同步
4. 检查确认匹配页和查看明细页的附件是否按明细行分开

## 适用范围

- 本地修复
- 生产受控重建

## 注意事项

- 只建议用于审批派生数据错误的场景
- 不要用它清理门店、用户、部门以外的基础数据
- 如果只修某个门店，先补定点重建能力，再执行

