from collections.abc import Generator
import os
import re

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.sql import text

from app import models  # noqa: F401
from app.core.config import settings
from app.core.database import Base, get_session
from app.core.security import hash_password
from app.main import app
from app.models import User

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+psycopg://finhub:finhub@localhost:5432/finhub",
)
TEST_DATABASE_SCHEMA = os.environ.get("TEST_DATABASE_SCHEMA", "finhub_test")


@pytest.fixture(autouse=True)
def test_dingtalk_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep legacy mock scenarios isolated from the real local/runtime default."""
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "mock")


def test_engine():
    url = make_url(TEST_DATABASE_URL)
    if url.get_backend_name() != "postgresql":
        msg = "TEST_DATABASE_URL must use PostgreSQL"
        raise RuntimeError(msg)
    if not TEST_DATABASE_SCHEMA or not re.fullmatch(r"[A-Za-z0-9_]+", TEST_DATABASE_SCHEMA):
        msg = "TEST_DATABASE_SCHEMA must contain only letters, numbers, and underscores"
        raise RuntimeError(msg)
    schema_url = url.update_query_dict({"options": f"-csearch_path={TEST_DATABASE_SCHEMA}"})
    return create_engine(schema_url, pool_pre_ping=True)


def reset_test_schema(engine) -> None:
    with engine.connect() as connection:
        connection.execute(text(f'drop schema if exists "{TEST_DATABASE_SCHEMA}" cascade'))
        connection.execute(text(f'create schema "{TEST_DATABASE_SCHEMA}"'))
        connection.commit()


@pytest.fixture()
def session() -> Generator[Session, None, None]:
    engine = test_engine()
    reset_test_schema(engine)
    Base.metadata.create_all(engine)
    TestingSessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with TestingSessionLocal() as db_session:
        yield db_session
    reset_test_schema(engine)
    engine.dispose()


@pytest.fixture()
def anonymous_client(session: Session) -> Generator[TestClient, None, None]:
    def override_get_session() -> Generator[Session, None, None]:
        yield session

    app.dependency_overrides[get_session] = override_get_session
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture()
def client(session: Session) -> Generator[TestClient, None, None]:
    session.add(
        User(
            username="admin",
            display_name="系统管理员",
            password_hash=hash_password("admin123456"),
            role="admin",
            status="active",
        )
    )
    session.commit()

    def override_get_session() -> Generator[Session, None, None]:
        yield session

    app.dependency_overrides[get_session] = override_get_session
    with TestClient(app) as test_client:
        response = test_client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "admin123456"},
        )
        assert response.status_code == 200
        yield test_client
    app.dependency_overrides.clear()
