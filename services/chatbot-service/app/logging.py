import json
import logging
import sys
import time

# Only these extra fields are ever written. Anything else passed to a log call is dropped, so a careless call can't
# leak a chat message, a prompt, an answer, an address or the API key.
ALLOWED = {
    "requestId", "method", "path", "status", "ms", "intent", "pii", "retrieved", "model", "outcome", "degraded",
    "tokens", "chunks", "embedded", "deleted", "error", "reason", "count",
}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)), "level": record.levelname.lower(), "service": "chatbot-service", "msg": record.getMessage()}
        for key in ALLOWED:
            if hasattr(record, key):
                out[key] = getattr(record, key)
        return json.dumps(out, default=str)


def setup_logging() -> logging.Logger:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(logging.INFO)
    # These libraries print URLs, and google-genai can put the API key in one. Keep them quiet.
    for noisy in ("httpx", "httpcore", "google_genai", "google.genai", "uvicorn.access"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    return logging.getLogger("chatbot")
