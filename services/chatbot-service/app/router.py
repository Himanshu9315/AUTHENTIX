import re
import unicodedata
from datetime import UTC, datetime
from typing import Protocol

from app.models import LiveData, LiveEvent, LiveTier

# Prices, availability and dates are answered from LIVE catalog/inventory data with a fixed sentence: the model is never
# asked, so it can't invent or misremember them. Deliberately plain keyword rules (testable, free, predictable). A
# phrasing it misses just gets a normal help answer, which cannot contain those numbers.

_PRICE = re.compile(r"\b(price|prices|pricing|cost|costs|how much|fee|fees|rs|inr|rupees?)\b|₹", re.IGNORECASE)
_AVAILABILITY = re.compile(r"\b(available|availability|sold out|seats? left|tickets? left|remaining|still (?:any|have|got))\b", re.IGNORECASE)
_SCHEDULE = re.compile(r"\b(when does|when is|what time|start time|starts|starting|doors|what day|dates?|schedule)\b", re.IGNORECASE)
# Words that show a question is about how Authentix works, not about one event's live numbers.
HELP_TOPICS = re.compile(r"\b(transfer\w*|refund\w*|hold|held|timer|limit|cap|queue|waiting room|verif\w*|aadhaar|account|email|scanner|otp|password|privacy|qr|entry code|resell|resale|support)\b", re.IGNORECASE)
# Words that clearly ask for a live figure, which win even if a help word is present ("how much is a transfer ... ticket").
STRONG_LIVE = re.compile(r"\b(price|prices|cost|costs|how much|rs|inr|rupees?|sold out|seats? left|tickets? left)\b|₹", re.IGNORECASE)


def wants_help_instead(message: str) -> bool:
    """A help-topic question without a clear ask for a live figure is a help question, even if it mentions 'fee' or 'time'."""
    return bool(HELP_TOPICS.search(message)) and not STRONG_LIVE.search(message)


class LiveSource(Protocol):
    async def get_event(self, slug: str) -> dict | None: ...
    async def get_availability(self, event_id: str) -> dict[str, int]: ...


def intents(message: str) -> set[str]:
    found = set()
    if _PRICE.search(message):
        found.add("price")
    if _AVAILABILITY.search(message):
        found.add("availability")
    if _SCHEDULE.search(message):
        found.add("schedule")
    return found


def _fold(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).casefold()
    return " ".join(re.sub(r"[^\w]+", " ", text).split())


def resolve_event(message: str, slug: str | None, events: list[tuple[str, str]]) -> tuple[str, list[tuple[str, str]]]:
    """Which event does the question mean?  Returns (kind, matches).

    Safest first: the page the widget was opened on, then a whole-title match (word boundaries, case-folded) against
    events we know. Never fuzzy, never guessed by a vector search or by the model.
    kind: "slug" | "title" | "ambiguous" | "none"
    """
    if slug:
        return "slug", [(slug, slug)]
    padded = f" {_fold(message)} "
    hits = [(s, t) for s, t in events if _fold(t) and f" {_fold(t)} " in padded]
    # "Blue Lotus" inside "Blue Lotus Orchestra" counts once, so keep only titles not contained in a DIFFERENT, longer title.
    # Two events with the very same title (a tour) are both kept, which makes the question ambiguous, as it should be.
    hits = [h for h in hits if not any(h is not o and _fold(h[1]) != _fold(o[1]) and _fold(h[1]) in _fold(o[1]) for o in hits)]
    if len(hits) == 1:
        return "title", hits
    return ("ambiguous", hits[:3]) if hits else ("none", [])


async def live_data(source: LiveSource, slug: str, want_availability: bool) -> LiveData | None:
    """Fetches the event and (if asked) its stock. None if the event doesn't exist. Raises if a service is down."""
    ev = await source.get_event(slug)
    if ev is None:
        return None
    stock: dict[str, int] = {}
    if want_availability:
        stock = await source.get_availability(ev["id"])
    return LiveData(
        event=LiveEvent(slug=ev["slug"], title=ev["title"], startsAt=ev["startsAt"], endsAt=ev["endsAt"], venueName=ev["venue"]["name"], city=ev["venue"]["city"]),
        tiers=[LiveTier(name=t["name"], priceInr=t["priceInr"], available=stock.get(t["id"]) if want_availability else None) for t in ev["tiers"]],
        fetchedAt=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    )
