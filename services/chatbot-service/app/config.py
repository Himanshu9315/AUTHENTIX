from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Everything comes from environment variables. The Gemini key is never hard-coded and may be empty (the bot then degrades)."""

    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    port: int = 3011
    database_url: str = "postgresql://authentix:authentix@localhost:5433/chatbot"
    catalog_url: str = "http://localhost:3003"
    inventory_url: str = "http://localhost:3004"
    internal_token: SecretStr = SecretStr("")
    web_base_url: str = "http://localhost:8080"

    gemini_api_key: SecretStr = SecretStr("")
    gemini_chat_model: str = "gemini-3.5-flash-lite"
    gemini_embed_model: str = "gemini-embedding-2"
    gemini_embed_dimensions: int = 768
    # 0 switches "thinking" off, so the model doesn't spend its small output budget on hidden reasoning.
    gemini_thinking_budget: int = 0
    gemini_timeout_ms: int = 15_000

    min_similarity: float = 0.70  # calibrated on 15 fictional questions: lowest answerable 0.759, highest unanswerable 0.644
    reindex_seconds: int = 900
    max_gemini_calls_per_day: int = 500
    rate_limit_per_minute: int = 30
    rate_limit_tracked_addresses: int = 10_000  # how many addresses the in-service limiter remembers
    knowledge_dir: str = "knowledge"

    @property
    def has_key(self) -> bool:
        return bool(self.gemini_api_key.get_secret_value().strip())
