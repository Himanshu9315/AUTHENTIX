# chatbot-service: Python 3.12, non-root. Build context is the repo root.
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv
COPY services/chatbot-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

FROM base AS test
# Checks the service on Python 3.12 (the local venv may be newer):  docker build --target test -f services/chatbot-service/Dockerfile .
COPY services/chatbot-service/requirements-dev.txt .
RUN pip install --no-cache-dir -r requirements-dev.txt
COPY contracts /contracts
COPY services/chatbot-service/ .
ENV CONTRACTS_DIR=/contracts
RUN ruff check . && pytest -q

FROM base AS run
COPY services/chatbot-service/app ./app
COPY services/chatbot-service/knowledge ./knowledge
RUN useradd --system --uid 10001 app
USER app
EXPOSE 3011
CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "3011"]
