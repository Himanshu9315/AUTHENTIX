import httpx


class HttpLiveSource:
    """Reads the same PUBLIC catalog and inventory APIs any visitor can. No credentials, no user data."""

    def __init__(self, catalog_url: str, inventory_url: str, client: httpx.AsyncClient | None = None):
        self.catalog = catalog_url.rstrip("/")
        self.inventory = inventory_url.rstrip("/")
        self.http = client or httpx.AsyncClient(timeout=4.0)

    async def get_event(self, slug: str) -> dict | None:
        r = await self.http.get(f"{self.catalog}/catalog/events/{slug}")
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

    async def get_availability(self, event_id: str) -> dict[str, int]:
        r = await self.http.get(f"{self.inventory}/inventory/events/{event_id}")
        r.raise_for_status()
        return {t["tierId"]: t["available"] for t in r.json()["tiers"]}

    async def list_events(self) -> list[dict] | None:
        """Every event with its description. None if ANY page or detail failed, so a catalog outage can't empty the index."""
        out: list[dict] = []
        try:
            offset = 0
            while True:
                r = await self.http.get(f"{self.catalog}/catalog/events", params={"limit": 50, "offset": offset})
                r.raise_for_status()
                items = r.json()["items"]
                for item in items:
                    d = await self.http.get(f"{self.catalog}/catalog/events/{item['slug']}")
                    d.raise_for_status()
                    out.append(d.json())
                if len(items) < 50:
                    return out
                offset += 50
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            return None  # any failure (network, bad JSON, missing field) means "incomplete", so nothing gets deleted

    async def aclose(self) -> None:
        await self.http.aclose()
