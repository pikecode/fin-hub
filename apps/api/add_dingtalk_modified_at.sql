-- 添加 dingtalk_modified_at 字段到 approval_instances 表

-- 检查字段是否已存在
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name='approval_instances'
        AND column_name='dingtalk_modified_at'
    ) THEN
        -- 添加字段
        ALTER TABLE approval_instances
        ADD COLUMN dingtalk_modified_at TIMESTAMP;

        -- 为现有数据设置默认值（使用 approved_at 或 created_at）
        UPDATE approval_instances
        SET dingtalk_modified_at = COALESCE(approved_at, created_at)
        WHERE dingtalk_modified_at IS NULL;

        RAISE NOTICE '✅ 已添加 dingtalk_modified_at 字段并设置默认值';
    ELSE
        RAISE NOTICE '⚠️  dingtalk_modified_at 字段已存在，跳过';
    END IF;
END $$;
