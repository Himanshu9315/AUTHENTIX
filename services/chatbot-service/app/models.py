from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

SLUG = r"^[a-z0-9][a-z0-9-]{0,98}$"


class Strict(BaseModel):
    # strict: "1499" is not a number and 1 is not true. This matches the JSON Schema in contracts/ exactly.
    model_config = ConfigDict(extra="forbid", strict=True)


class Turn(Strict):
    role: Literal["user", "model"]
    text: str = Field(min_length=1, max_length=500)


class ChatContext(Strict):
    eventSlug: str | None = Field(default=None, pattern=SLUG)  # noqa: N815 (names mirror the JSON contract)


class ChatRequest(Strict):
    message: str = Field(min_length=1, max_length=500)
    history: list[Turn] = Field(default_factory=list, max_length=6)
    context: ChatContext | None = None


class Source(Strict):
    id: str = Field(min_length=1, max_length=200)
    kind: Literal["faq", "event"]
    title: str
    path: str


class LiveTier(Strict):
    name: str
    priceInr: int = Field(ge=0)  # noqa: N815
    available: int | None = Field(ge=0)


class LiveEvent(Strict):
    slug: str = Field(pattern=SLUG)
    title: str
    startsAt: str  # noqa: N815
    endsAt: str  # noqa: N815
    venueName: str  # noqa: N815
    city: str


class LiveData(Strict):
    event: LiveEvent
    tiers: list[LiveTier]
    fetchedAt: str  # noqa: N815


class Flags(Strict):
    grounded: bool
    refused: Literal["personal_data", "out_of_scope"] | None
    degraded: Literal["no_api_key", "rate_limited", "unavailable", "blocked", "budget"] | None
    liveDataRedirect: bool  # noqa: N815


class ChatResponse(Strict):
    answer: str
    sources: list[Source]
    liveData: LiveData | None  # noqa: N815
    flags: Flags
    requestId: str  # noqa: N815


class ModelAnswer(BaseModel):
    """What the model must return (as JSON). Citations are rebuilt by the service from this, never trusted as prose."""

    answer: str
    used_source_ids: list[str] = Field(default_factory=list)
