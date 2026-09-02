"""
简单的基于内存的限流中间件
生产环境建议使用 Redis 存储
"""
import time
from collections import defaultdict
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import Request, Response, status
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware


class RateLimitMiddleware(BaseHTTPMiddleware):
    """
    简单的滑动窗口限流中间件
    """

    def __init__(
        self,
        app: Any,
        requests_per_minute: int = 60,
        exclude_paths: list[str] | None = None,
    ):
        super().__init__(app)
        self.requests_per_minute = requests_per_minute
        self.window_size = 60  # 1 分钟窗口
        self.exclude_paths = exclude_paths or ["/api/health", "/openapi.json", "/docs"]
        # 存储格式: {ip: [(timestamp1, ...), ...]}
        self.requests: dict[str, list[float]] = defaultdict(list)

    def _get_client_ip(self, request: Request) -> str:
        """获取客户端 IP"""
        # 优先从 X-Forwarded-For 获取（反向代理场景）
        forwarded = request.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[0].strip()
        # 从 X-Real-IP 获取
        real_ip = request.headers.get("X-Real-IP")
        if real_ip:
            return real_ip
        # 直接连接场景
        return request.client.host if request.client else "unknown"

    def _clean_old_requests(self, ip: str) -> None:
        """清理过期的请求记录"""
        current_time = time.time()
        cutoff_time = current_time - self.window_size
        self.requests[ip] = [ts for ts in self.requests[ip] if ts > cutoff_time]

    def _is_rate_limited(self, ip: str) -> bool:
        """检查是否超过限流"""
        self._clean_old_requests(ip)
        return len(self.requests[ip]) >= self.requests_per_minute

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        # 跳过不需要限流的路径
        if any(request.url.path.startswith(path) for path in self.exclude_paths):
            return await call_next(request)

        client_ip = self._get_client_ip(request)

        # 检查是否超限
        if self._is_rate_limited(client_ip):
            return JSONResponse(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                content={
                    "detail": f"请求过于频繁，请稍后再试（限制：{self.requests_per_minute} 次/分钟）"
                },
                headers={"Retry-After": "60"},
            )

        # 记录本次请求
        self.requests[client_ip].append(time.time())

        # 继续处理请求
        response = await call_next(request)
        return response


def create_rate_limit_middleware(
    requests_per_minute: int = 60,
    exclude_paths: list[str] | None = None,
) -> type[RateLimitMiddleware]:
    """
    创建限流中间件工厂函数

    Args:
        requests_per_minute: 每分钟允许的请求数
        exclude_paths: 不需要限流的路径列表
    """

    class ConfiguredRateLimitMiddleware(RateLimitMiddleware):
        def __init__(self, app: Any):
            super().__init__(app, requests_per_minute, exclude_paths)

    return ConfiguredRateLimitMiddleware
