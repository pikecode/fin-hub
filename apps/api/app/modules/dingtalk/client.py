from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from time import sleep
from typing import Any

import httpx

from app.core.config import settings


class DingTalkClientError(RuntimeError):
    pass


@dataclass(frozen=True)
class DingTalkCredentials:
    app_key: str
    app_secret: str


class DingTalkClient:
    def __init__(
        self,
        credentials: DingTalkCredentials,
        api_base_url: str | None = None,
        oapi_base_url: str | None = None,
        timeout: float = 20.0,
    ) -> None:
        self.credentials = credentials
        self.api_base_url = (api_base_url or settings.dingtalk_api_base_url).rstrip("/")
        self.oapi_base_url = (oapi_base_url or settings.dingtalk_oapi_base_url).rstrip("/")
        self.timeout = timeout

    def get_access_token(self) -> str:
        response = httpx.post(
            f"{self.api_base_url}/v1.0/oauth2/accessToken",
            json={"appKey": self.credentials.app_key, "appSecret": self.credentials.app_secret},
            timeout=self.timeout,
        )
        data = self._read_json(response)
        token = data.get("accessToken") or data.get("access_token")
        if not token:
            raise DingTalkClientError(f"DingTalk access token missing: {data}")
        return str(token)

    def list_processes_by_user(self, user_id: str, offset: int = 0, size: int = 100) -> list[dict[str, Any]]:
        data = self._post_oapi_json(
            "/topapi/process/listbyuserid",
            {"userid": user_id, "offset": offset, "size": size},
        )
        result = data.get("result") or {}
        items = result.get("process_list") or result.get("list") or []
        return [item for item in items if isinstance(item, dict)]

    def list_child_departments(self, dept_id: int | str = 1) -> list[dict[str, Any]]:
        data = self._post_oapi_json(
            "/topapi/v2/department/listsub",
            {"dept_id": dept_id, "language": "zh_CN"},
        )
        result = data.get("result") or []
        return [item for item in result if isinstance(item, dict)]

    def list_process_instance_ids(
        self,
        process_code: str,
        start_time_ms: int,
        end_time_ms: int,
        cursor: int = 0,
        size: int = 20,
    ) -> tuple[list[str], int | None]:
        data = self._post_oapi_json(
            "/topapi/processinstance/listids",
            {
                "process_code": process_code,
                "start_time": start_time_ms,
                "end_time": end_time_ms,
                "cursor": cursor,
                "size": size,
            },
        )
        result = data.get("result") or {}
        ids = result.get("list") or []
        next_cursor = result.get("next_cursor")
        return [str(item) for item in ids], int(next_cursor) if next_cursor is not None else None

    def get_process_instance(self, instance_id: str) -> dict[str, Any]:
        data = self._post_oapi_json(
            "/topapi/processinstance/get",
            {"process_instance_id": instance_id},
        )
        result = data.get("process_instance") or data.get("result")
        if not isinstance(result, dict):
            raise DingTalkClientError(f"DingTalk approval instance missing: {data}")
        return result

    def get_drive_download_url(self, space_id: str, file_id: str, union_id: str) -> str:
        token = self.get_access_token()
        response = httpx.get(
            f"{self.api_base_url}/v1.0/drive/spaces/{space_id}/files/{file_id}/downloadInfos",
            headers={"x-acs-dingtalk-access-token": token},
            params={"unionId": union_id},
            timeout=self.timeout,
        )
        data = self._read_json(response)
        url = data.get("downloadUrl") or data.get("download_url") or data.get("url")
        if not url:
            raise DingTalkClientError(f"DingTalk drive download URL missing: {data}")
        return str(url)

    @staticmethod
    def parse_time(value: Any) -> datetime | None:
        if value is None:
            return None
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value / 1000, tz=UTC)
        if isinstance(value, str):
            try:
                return datetime.fromisoformat(value)
            except ValueError:
                return None
        return None

    @staticmethod
    def _read_json(response: httpx.Response) -> dict[str, Any]:
        try:
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise DingTalkClientError(f"DingTalk request failed: {exc}") from exc
        if not isinstance(data, dict):
            raise DingTalkClientError("DingTalk response is not a JSON object")
        return data

    def _post_oapi_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        last_error: DingTalkClientError | None = None
        for attempt in range(3):
            token = self.get_access_token()
            response = httpx.post(
                f"{self.oapi_base_url}{path}",
                params={"access_token": token},
                json=payload,
                timeout=self.timeout,
            )
            data = self._read_json(response)
            errcode = data.get("errcode", 0)
            if errcode in (0, "0", None):
                return data
            last_error = DingTalkClientError(data.get("errmsg") or f"DingTalk API error: {data}")
            if str(errcode) != "90002" or attempt == 2:
                break
            sleep(1.0 + attempt)
        if last_error is not None:
            raise last_error
        raise DingTalkClientError("DingTalk OAPI request failed")

    @classmethod
    def _read_oapi_json(cls, response: httpx.Response) -> dict[str, Any]:
        data = cls._read_json(response)
        errcode = data.get("errcode", 0)
        if errcode not in (0, "0", None):
            raise DingTalkClientError(data.get("errmsg") or f"DingTalk API error: {data}")
        return data
