ARG PYTHON_BASE_IMAGE=python:3.12-slim
FROM ${PYTHON_BASE_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ \
    PIP_TRUSTED_HOST=mirrors.aliyun.com

WORKDIR /app

COPY apps/api/pyproject.toml ./pyproject.toml
RUN pip install --no-cache-dir -e .

COPY apps/api/app ./app
COPY apps/api/alembic.ini ./alembic.ini
COPY apps/api/alembic ./alembic

EXPOSE 8000

CMD ["sh", "-c", "alembic upgrade head && if [ \"$SEED_DEV_DATA\" = \"true\" ]; then python -m app.dev_seed; fi && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
