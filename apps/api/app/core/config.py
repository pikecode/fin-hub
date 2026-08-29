from functools import cached_property

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: str = "local"
    secret_key: str = Field(default="dev-secret", validation_alias="SECRET_KEY")
    database_url: str = Field(
        default="postgresql+psycopg://finhub:finhub@localhost:5432/finhub",
        validation_alias="DATABASE_URL",
    )
    redis_url: str = Field(default="redis://localhost:6379/0", validation_alias="REDIS_URL")
    file_storage_root: str = Field(default="./data/files", validation_alias="FILE_STORAGE_ROOT")
    dingtalk_api_base_url: str = Field(
        default="https://api.dingtalk.com",
        validation_alias="DINGTALK_API_BASE_URL",
    )
    dingtalk_oapi_base_url: str = Field(
        default="https://oapi.dingtalk.com",
        validation_alias="DINGTALK_OAPI_BASE_URL",
    )
    dingtalk_sync_mode: str = Field(default="mock", validation_alias="DINGTALK_SYNC_MODE")
    dingtalk_app_key: str | None = Field(default=None, validation_alias="DINGTALK_APP_KEY")
    dingtalk_app_secret: str | None = Field(default=None, validation_alias="DINGTALK_APP_SECRET")
    dingtalk_drive_union_id: str | None = Field(default=None, validation_alias="DINGTALK_DRIVE_UNION_ID")
    cors_origin_csv: str = Field(
        default="http://localhost:3000,http://localhost:10086",
        validation_alias="CORS_ORIGINS",
    )

    @cached_property
    def cors_origins(self) -> list[str]:
        return [item.strip() for item in self.cors_origin_csv.split(",") if item.strip()]


settings = Settings()
