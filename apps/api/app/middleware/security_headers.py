"""
安全响应头中间件
添加常见的安全 HTTP 头
"""
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """
    添加安全响应头中间件
    - X-Content-Type-Options: nosniff
    - X-Frame-Options: DENY
    - X-XSS-Protection: 1; mode=block
    - Strict-Transport-Security: HTTPS only (生产环境)
    - Content-Security-Policy: 基础 CSP
    """

    def __init__(self, app: Any, enable_hsts: bool = False):
        super().__init__(app)
        self.enable_hsts = enable_hsts

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        response = await call_next(request)

        # 防止 MIME 类型嗅探
        response.headers["X-Content-Type-Options"] = "nosniff"

        # 防止点击劫持
        response.headers["X-Frame-Options"] = "DENY"

        # XSS 保护（现代浏览器已内置，但保留兼容性）
        response.headers["X-XSS-Protection"] = "1; mode=block"

        # 基础 CSP（API 服务器通常只返回 JSON，限制脚本执行）
        response.headers["Content-Security-Policy"] = "default-src 'self'; frame-ancestors 'none'"

        # Referrer 策略
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"

        # HTTPS 强制（生产环境）
        if self.enable_hsts:
            # max-age=31536000 (1年), includeSubDomains
            response.headers["Strict-Transport-Security"] = (
                "max-age=31536000; includeSubDomains"
            )

        # 权限策略（禁用不需要的浏览器特性）
        response.headers["Permissions-Policy"] = (
            "geolocation=(), microphone=(), camera=(), payment=()"
        )

        return response


def create_security_headers_middleware(enable_hsts: bool = False) -> type[SecurityHeadersMiddleware]:
    """
    创建安全头中间件工厂函数

    Args:
        enable_hsts: 是否启用 HSTS（仅 HTTPS 环境）
    """

    class ConfiguredSecurityHeadersMiddleware(SecurityHeadersMiddleware):
        def __init__(self, app: Any):
            super().__init__(app, enable_hsts)

    return ConfiguredSecurityHeadersMiddleware
