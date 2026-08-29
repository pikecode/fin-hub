from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app import models  # noqa: F401
from app.core.database import Base, get_session
from app.core.security import hash_password
from app.main import app
from app.models import User


@pytest.fixture()
def session() -> Generator[Session, None, None]:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    TestingSessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with TestingSessionLocal() as db_session:
        yield db_session


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
