from app.modules.dingtalk.client import DingTalkClientError
from app.modules.dingtalk.router import is_missing_dingtalk_approval_error


def test_missing_dingtalk_approval_flow_is_skippable() -> None:
    assert is_missing_dingtalk_approval_error(DingTalkClientError("审批流不存在")) is True
    assert is_missing_dingtalk_approval_error(DingTalkClientError("流程不存在")) is True


def test_other_dingtalk_errors_are_not_skippable() -> None:
    assert is_missing_dingtalk_approval_error(DingTalkClientError("请求频率受限")) is False
