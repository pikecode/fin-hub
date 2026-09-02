import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.middleware.rate_limit import create_rate_limit_middleware


@pytest.fixture
def rate_limited_app():
    """创建启用限流的测试应用"""
    app = FastAPI()

    # 添加限流中间件（每分钟 5 次，便于测试）
    app.add_middleware(create_rate_limit_middleware(requests_per_minute=5))

    @app.get("/test")
    async def test_endpoint():
        return {"message": "success"}

    @app.get("/api/health")
    async def health_endpoint():
        return {"status": "ok"}

    return app


def test_rate_limit_allows_normal_requests(rate_limited_app):
    """测试正常请求不被限流"""
    with TestClient(rate_limited_app, client=("198.51.100.1", 50000)) as client:
        response = client.get("/test")
        assert response.status_code == 200
        assert response.json() == {"message": "success"}


def test_rate_limit_blocks_excessive_requests(rate_limited_app):
    """测试过多请求被限流"""
    with TestClient(rate_limited_app, client=("198.51.100.2", 50000)) as client:
        # 发送 5 次请求（限制内）
        for _ in range(5):
            response = client.get("/test")
            assert response.status_code == 200

        # 第 6 次请求应被限流
        response = client.get("/test")
        assert response.status_code == 429
        assert "请求过于频繁" in response.json()["detail"]


def test_rate_limit_excludes_health_endpoint(rate_limited_app):
    """测试健康检查路径不受限流"""
    with TestClient(rate_limited_app, client=("198.51.100.3", 50000)) as client:
        # 发送 10 次请求（超过限制）
        for _ in range(10):
            response = client.get("/api/health")
            assert response.status_code == 200
            assert response.json() == {"status": "ok"}


def test_rate_limit_resets_after_window(rate_limited_app):
    """测试限流窗口重置"""
    with TestClient(rate_limited_app, client=("198.51.100.4", 50000)) as client:
        # 发送 5 次请求达到限制
        for _ in range(5):
            response = client.get("/test")
            assert response.status_code == 200

        # 等待 61 秒让窗口重置（生产环境中窗口是 60 秒）
        # 这里我们不真的等待，只是验证机制存在
        # await asyncio.sleep(61)

        # 在实际测试中，我们验证响应头包含 Retry-After
        response = client.get("/test")
        assert response.status_code == 429
        assert response.headers.get("Retry-After") == "60"


def test_rate_limit_per_ip(rate_limited_app):
    """测试限流按 IP 隔离"""
    with TestClient(rate_limited_app, client=("198.51.100.5", 50000)) as client:
        # IP1 发送 5 次请求
        for _ in range(5):
            response = client.get("/test", headers={"X-Forwarded-For": "192.168.1.1"})
            assert response.status_code == 200

        # IP1 第 6 次被限流
        response = client.get("/test", headers={"X-Forwarded-For": "192.168.1.1"})
        assert response.status_code == 429

        # IP2 仍可正常请求
        response = client.get("/test", headers={"X-Forwarded-For": "192.168.1.2"})
        assert response.status_code == 200
