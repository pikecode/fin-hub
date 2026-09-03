#!/usr/bin/env python3
import sys
import os

# 添加项目路径
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'apps/api'))

try:
    from app.models import ApprovalInstance
    from sqlalchemy import inspect

    # 获取 ApprovalInstance 的所有列
    mapper = inspect(ApprovalInstance)
    columns = [c.key for c in mapper.columns]

    print("ApprovalInstance columns:")
    for col in sorted(columns):
        print(f"  - {col}")

    # 检查 dingtalk_modified_at 是否存在
    if 'dingtalk_modified_at' in columns:
        print("\n✅ dingtalk_modified_at 字段已添加到模型")
    else:
        print("\n❌ dingtalk_modified_at 字段不在模型中")

except Exception as e:
    print(f"❌ 错误: {e}")
    import traceback
    traceback.print_exc()
