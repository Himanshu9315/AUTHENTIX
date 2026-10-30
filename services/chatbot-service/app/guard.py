import re
from urllib.parse import urlparse

from app import pii

REDIRECT = "I can't quote prices, dates or availability. Open the event page for live details."
SAFE_FALLBACK = "Sorry, I can't help with that one. Please see Contact support."
SUPPORT_EMAIL = "support@authentix.test"  # the one address the help articles tell people to use

_MONTH = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
_WEEKDAY = r"(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?"
_MONEY = re.compile(
    r"(₹|\brs\.?|\binr)\s*\d|\d\s*(rupees|/-)|\brupees?\b|\bfree of charge\b|\b\d+(?:\.\d+)?\s*k\b|\b(hundred|thousand|lakh|crore)\b"
    r"|\b(free|complimentary)\s+(tickets?|entry|admission)\b",
    re.IGNORECASE,
)
_AVAILABILITY = re.compile(
    r"sold[\s-]*out|\b\d+\s+(seats?|tickets?)\s+(left|remaining|available)\b|\bonly\s+\d+\s+left\b"
    r"|\b(tickets?|seats?)\s+(are\s+|is\s+)?(still\s+)?(available|left|remaining)\b|\bselling\s+fast\b|\b(few|limited)\s+(tickets?|seats?)\b",
    re.IGNORECASE,
)
_DATE = re.compile(
    rf"\b\d{{1,2}}[:.]\d{{2}}\s*(am|pm)?\b|\b\d{{1,2}}\s*[ap]\.?m\b\.?|\b\d{{1,2}}h\b|\bo'?clock\b|\bdoors?\s+(open\s+)?at\s+\d|\b(tomorrow|tonight)\b|\bon\s+the\s+\d{{1,2}}(st|nd|rd|th)\b|\bnext\s+{_WEEKDAY}\b"
    rf"|\b\d{{1,2}}(st|nd|rd|th)?\s+(?:of\s+)?(?:{_MONTH}|may)\b|\b{_MONTH}\s+\d{{1,2}}(st|nd|rd|th)?\b|\b{_MONTH}\s+\d{{4}}\b"
    rf"|\b\d{{1,2}}/\d{{1,2}}/\d{{2,4}}\b|\b\d{{4}}-\d{{2}}-\d{{2}}\b|\b{_WEEKDAY}\s+(morning|afternoon|evening|night)\b",
    re.IGNORECASE,
)
# Help articles never need a number of three or more digits (their numbers are things like 24 hours, 30 seconds, 4 tickets),
# so one appearing in a model answer is a figure it made up or copied from an organiser's text.
_BIG_NUMBER = re.compile(r"(?<![\w.])\d{3,}(?![\w])")
# Anything that looks like a link: with a scheme, protocol-relative, javascript:/data:, www., or domain/path.
_LINKISH = re.compile(
    r"(?:https?:)?//[^\s)>\]]+|\b(?:javascript|data|vbscript):\S*|\bwww\.[^\s)>\]]+|\b[\w-]+(?:\.[\w-]+)+/[^\s)>\]]*"
    r"|\b[\w-]+(?:\.|\[\.\]|\(\.\)|\s\.\s)[a-z]{2,}\b",  # any "name.tld", also written evil[.]test or evil . test
    re.IGNORECASE,
)
_MAIL_MARK = "\x00MAIL\x00"


def _strip_links(text: str, web_base_url: str) -> tuple[str, list[str]]:
    """Removes every link that is not ours. Our own links are set aside (so their port numbers can't trip the number checks)
    and put back afterwards. Returns the text with markers, and the kept links."""
    base = urlparse(web_base_url)
    kept: list[str] = []

    def keep_or_drop(m: re.Match) -> str:
        found = m.group(0)
        u = urlparse(found)
        # Our own address, exactly (same scheme and host and port), and nothing glued on to the host.
        if u.scheme == base.scheme and u.netloc == base.netloc and u.scheme in ("http", "https"):
            kept.append(found)
            return f"\x00L{len(kept) - 1}\x00"
        return ""

    return _LINKISH.sub(keep_or_drop, text), kept


def apply(answer: str, web_base_url: str) -> tuple[str, bool]:
    """Last line of defence on whatever the model wrote. Returns (text, liveDataRedirect).

    Numbers about money, availability and dates must come from live data, never from model prose, so any answer that
    contains them is replaced. Links to other sites are removed. An answer containing personal data is withheld.
    """
    # The help articles' own contact address is allowed (any letter case), but only as a whole address ("xsupport@..." is not it).
    protected = re.sub(r"(?<![\w.+-])" + re.escape(SUPPORT_EMAIL) + r"(?![\w-])", _MAIL_MARK, answer, flags=re.IGNORECASE)
    # Personal data first, on the untouched text (stripping links first could remove the domain from an email and hide it).
    if pii.has_pii(protected.replace(_MAIL_MARK, " ")):
        return SAFE_FALLBACK, False
    cleaned, kept = _strip_links(protected, web_base_url)
    if _MONEY.search(cleaned) or _AVAILABILITY.search(cleaned) or _DATE.search(cleaned) or _BIG_NUMBER.search(cleaned):
        return REDIRECT, True
    text = cleaned.replace(_MAIL_MARK, SUPPORT_EMAIL)
    for i, link in enumerate(kept):
        text = text.replace(f"\x00L{i}\x00", link)
    return re.sub(r"[ \t]{2,}", " ", text).strip() or SAFE_FALLBACK, False
