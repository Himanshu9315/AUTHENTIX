import re
import unicodedata

# Personal-data guard. Runs on every message BEFORE anything is logged, embedded or sent to Gemini. It refuses rather than
# masks: a masked number can still leak digits, and a missed number costs more than a wrongly refused question.
#
# Before looking for numbers the text is "flattened", so tricks that split a number up don't work: invisible characters
# (zero-width spaces, soft hyphens) are removed, every kind of whitespace and control character becomes a space, other
# scripts' digits become 0-9, and digits separated by spaces, dots, dashes, commas, slashes, colons or brackets are joined.

# Between two digits, up to three characters that aren't letters, digits or "@" (spaces, dots, dashes, commas, slashes, stars,
# bullets, brackets, anything) join them into one run. Letters between digits are not joined: that is "out of scope" on purpose.
_SEPARATORS = re.compile(r"(?<=\d)(?:[^\w@]|_){1,3}(?=\d)")
_DATE = re.compile(r"(?<!\d)(\d{1,2})([-/.])(\d{1,2})\2(\d{2,4})(?!\d)|(?<!\d)(\d{4})([-/.])(\d{1,2})\6(\d{1,2})(?!\d)")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_OTP_WORDS = re.compile(r"\b(otp|one[- ]time|code|pin|password|passcode)\b", re.IGNORECASE)
_RUN = re.compile(r"(?<!\d)\d{4,}(?!\d)")
_PHONE = re.compile(r"(?<!\d)(?:\+?91)?[6-9]\d{9}(?!\d)")


def normalise(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    out = []
    for ch in text:
        cat = unicodedata.category(ch)
        if cat in ("Cf", "Mn", "Me"):  # zero-width spaces and joiners, soft hyphens, variation selectors, combining accents: invisible or decorative, so drop them
            continue
        if cat in ("Cc", "Zs", "Zl", "Zp"):
            out.append(" ")  # tabs, newlines and every kind of space become a plain space
        elif ch.isdigit() and unicodedata.decimal(ch, None) is not None:
            out.append(str(unicodedata.decimal(ch)))  # digits of any script become 0-9
        else:
            out.append(ch)
    return _SEPARATORS.sub("", _exempt_dates("".join(out)))


def _valid_date(m: re.Match) -> bool:
    day, month, year = (int(m.group(1)), int(m.group(3)), int(m.group(4))) if m.group(1) else (int(m.group(8)), int(m.group(7)), int(m.group(5)))
    if m.group(1) and day <= 12 < month:  # dd-mm vs mm-dd: accept either order
        day, month = month, day
    return 1 <= month <= 12 and 1 <= day <= 31 and (year < 100 or 1900 <= year <= 2100)


def _exempt_dates(text: str) -> str:
    """A real, valid date standing on its own ("12-11-2026") is not personal data, and joining its parts would make it look
    like a number. But a date is only exempt if no other digits sit right next to it: "10-11-2026 1234" and "1000 10-11-2026" are
    twelve digits written to look like a date. Impossible dates (month 00, day 89) are never exempt."""
    out, last = [], 0
    for m in _DATE.finditer(text):
        before = text[: m.start()].rstrip(" .-/,:")
        after = text[m.end() :].lstrip(" .-/,:")
        if _valid_date(m) and not (before[-1:].isdigit() or after[:1].isdigit()):
            out.append(text[last : m.start()])
            out.append(" DATE ")
            last = m.end()
    out.append(text[last:])
    return "".join(out)


def _luhn(digits: str) -> bool:
    total, alt = 0, False
    for ch in reversed(digits):
        d = int(ch)
        if alt:
            d = d * 2 - 9 if d * 2 > 9 else d * 2
        total += d
        alt = not alt
    return total % 10 == 0


def detect(text: str) -> list[str]:
    """Names of the kinds of personal data found (never the data itself)."""
    norm = normalise(text)
    found: set[str] = set()
    if _EMAIL.search(norm):
        found.add("email")
    for run in (m.group() for m in _RUN.finditer(norm)):
        n = len(run)
        if n == 12:
            found.add("aadhaar")
        elif n == 16:
            found.add("vid")
            if _luhn(run):
                found.add("card")
        elif 13 <= n <= 19 and _luhn(run):
            found.add("card")
        elif n >= 10:
            found.add("phone")
    if _PHONE.search(norm):
        found.add("phone")
    only_digits = norm.replace(" ", "").isdigit()
    if (_OTP_WORDS.search(norm) or only_digits) and any(4 <= len(m.group()) <= 8 for m in _RUN.finditer(norm)):
        found.add("otp")
    return sorted(found)


def has_pii(text: str) -> bool:
    return bool(detect(text))
