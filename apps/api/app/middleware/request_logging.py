from __future__ import annotations

import time
from collections.abc import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.core.config import settings
from app.core.logging import get_logger


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    def __init__(
        self,
        app,
        *,
        slow_request_ms: int = 1000,
        large_response_bytes: int = 512 * 1024,
    ) -> None:
        super().__init__(app)
        self.slow_request_ms = slow_request_ms
        self.large_response_bytes = large_response_bytes
        self.logger = get_logger(__name__)

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        start = time.perf_counter()
        response: Response | None = None
        try:
            response = await call_next(request)
            return response
        finally:
            elapsed_ms = int((time.perf_counter() - start) * 1000)
            status_code = response.status_code if response is not None else 500
            content_length_header = response.headers.get("content-length") if response is not None else None
            content_length = _parse_int(content_length_header)
            should_log_slow = elapsed_ms >= self.slow_request_ms
            should_log_large = content_length is not None and content_length >= self.large_response_bytes
            should_log_error = status_code >= 500

            if should_log_slow or should_log_large or should_log_error:
                self.logger.warning(
                    "http_request_attention",
                    method=request.method,
                    path=request.url.path,
                    query=str(request.url.query)[:500],
                    status_code=status_code,
                    elapsed_ms=elapsed_ms,
                    content_length=content_length,
                    slow_request_ms=self.slow_request_ms,
                    large_response_bytes=self.large_response_bytes,
                    client=request.client.host if request.client else None,
                )


def _parse_int(value: str | None) -> int | None:
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def create_request_logging_middleware() -> type[RequestLoggingMiddleware]:
    class ConfiguredRequestLoggingMiddleware(RequestLoggingMiddleware):
        def __init__(self, app) -> None:
            super().__init__(
                app,
                slow_request_ms=settings.slow_request_ms,
                large_response_bytes=settings.large_response_bytes,
            )

    return ConfiguredRequestLoggingMiddleware
