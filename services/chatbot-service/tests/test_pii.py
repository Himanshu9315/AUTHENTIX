import asyncio
import json
import logging

import pytest

from app import pii
from app.models import ChatRequest
from app.service import REFUSAL_PII, ChatService
from tests.fakes import EVENTS, FAQ, FakeLive, FakeLLM, FakeStore, settings

# Fictional numbers only. Real Aadhaar numbers never start with 0 or 1, so these can never be real.
REFUSED = {
    "aadhaar": "my aadhaar is 1000 0000 0001 please check it",
    "aadhaar_dashes": "1000-0000-0002",
    "vid": "my VID is 1000000000000003",
    "card": "my card is 4242 4242 4242 4242",
    "email": "write to me at someone@example.test",
    "phone": "call me on +91 9812345678",
    "otp_word": "the otp I got is 482913",
    "otp_bare": "482913",
    "fullwidth_digits": "１０００ ００００ ０００４",
}


def service(llm=None):
    return ChatService(settings(), FakeStore(FAQ + EVENTS), llm or FakeLLM(), FakeLive())


def ask(svc, message, history=None):
    req = ChatRequest.model_validate({"message": message, "history": history or []})
    return asyncio.run(svc.chat(req, "0123456789abcdef"))


@pytest.mark.parametrize("name", REFUSED)
def test_personal_data_is_refused_without_calling_the_model(name, caplog):
    llm = FakeLLM()
    with caplog.at_level(logging.DEBUG):
        r = ask(service(llm), REFUSED[name])
    assert r.flags.refused == "personal_data"
    assert r.answer == REFUSAL_PII
    assert llm.calls == 0, "nothing may be sent to the model (not even for embedding)"
    # the logs may name the KIND of data, never the data
    everything = json.dumps([[r_.getMessage(), {k: str(v) for k, v in r_.__dict__.items()}] for r_ in caplog.records])
    digits = "".join(c for c in REFUSED[name] if c.isalnum() or c in "@.+")
    assert digits not in everything.replace(" ", "")
    assert "someone@example.test" not in everything


def test_personal_data_in_an_old_turn_is_dropped_before_the_model_sees_it():
    llm = FakeLLM()
    history = [{"role": "user", "text": "my email is leak@example.test"}, {"role": "model", "text": "Please don't share that."}, {"role": "user", "text": "ok, how do transfers work"}]
    ask(service(llm), "Can I transfer a ticket?", history)
    sent = json.dumps(llm.answer_calls[0]["history"])
    assert "leak@example.test" not in sent
    assert "how do transfers work" in sent


@pytest.mark.parametrize(
    "text",
    ["tickets under 1500 please", "How much for 4 tickets?", "Is the 12-11-2026 show open?", "can I book 2 tickets for event 2026", "What time does it start at 7 pm?", "order ref abcd1234"],
)
def test_ordinary_numbers_are_not_flagged(text):
    assert pii.detect(text) == []


def test_a_message_that_is_only_digits_is_treated_as_a_possible_code():
    # Deliberate: someone typing just "482913" is probably pasting a one-time code. A bare number like a price is refused too.
    assert pii.detect("1500") == ["otp"]


def test_detection_names_categories_only():
    assert pii.detect("1000 0000 0001") == ["aadhaar"]
    assert "card" in pii.detect("4242424242424242")
    assert "card" not in pii.detect("4242 4242 4242 4241")  # fails the check digit: not a card number


# Ways someone (or a paste from a form) might split a number so a naive check misses it. Each must still be caught,
# and the model must not be called.
BYPASSES = {
    "zero-width space": "1000\u200b0000\u200b0001",
    "comma": "1000,0000,0001",
    "slash": "1000/0000/0001",
    "newline": "1000\n0000\n0001",
    "tab": "1000\t0000\t0001",
    "soft hyphen": "1000\u00ad0000\u00ad0001",
    "en dash": "1000\u20130000\u20130001",
    "brackets": "(1000)(0000)(0001)",
    "colons": "1000:0000:0001",
    "single digits spaced": "1 0 0 0 0 0 0 0 0 0 0 1",
    "arabic-indic digits": "\u0661\u0660\u0660\u0660 \u0660\u0660\u0660\u0660 \u0660\u0660\u0660\u0661",
    "no-break space": "1000\u00a00000\u00a00001",
}


@pytest.mark.parametrize("name", BYPASSES)
def test_split_up_numbers_are_still_caught_and_never_reach_the_model(name):
    llm = FakeLLM()
    r = ask(service(llm), f"my number is {BYPASSES[name]} ok")
    assert r.flags.refused == "personal_data" and llm.calls == 0


def test_zero_width_characters_cannot_hide_an_email_or_a_phone_number():
    assert "email" in pii.detect("me\u200b@example.test")
    assert "email" in pii.detect("m\u2060e@exa\u200bmple.test")
    assert "phone" in pii.detect("98765\u200b43210")


@pytest.mark.parametrize("text", ["events 2026-10-31 code of conduct", "is the 12-11-2026 show open", "see you on 31.10.2026", "doors at 7:30 on 2026/10/31"])
def test_ordinary_dates_are_not_mistaken_for_personal_data(text):
    assert pii.detect(text) == []


# A number dressed up as a date, or split with other punctuation, must not slip through the date exemption or the separator list.
MORE = {
    "date-shaped, month 00": "1000-00-00 0001",
    "date-shaped, day 00": "10-00-0000 0001",
    "date-shaped with slashes": "10/00/0000 0001",
    "date-shaped, all dashes": "1000-00-00-0001",
    "date-shaped with dots": "10.00.0000.0001",
    "impossible month and day": "2345-67-89 0123",
    "a valid date followed by digits": "10-11-2026 1234",
    "digits then a valid date": "1000 10-11-2026",
    "stars": "1000*0000*0001",
    "plus signs": "1000+0000+0001",
    "hashes": "1000#0000#0001",
    "equals": "1000=0000=0001",
    "tildes": "1000~0000~0001",
    "semicolons": "1000;0000;0001",
    "ampersands": "1000&0000&0001",
    "exclamation": "1000!0000!0001",
    "bullet": "1000\u20220000\u20220001",
    "middle dot": "1000\u00b70000\u00b70001",
    "variation selector": "1000\ufe0f0000\ufe0f0001",
    "combining accent": "1000\u03010000\u03010001",
    "two separators": "1000 - 0000 - 0001",
}


@pytest.mark.parametrize("name", MORE)
def test_more_ways_of_hiding_a_number_are_caught(name):
    assert pii.detect(f"it is {MORE[name]} ok"), name


def test_a_real_date_on_its_own_is_still_just_a_date():
    for text in ["see you 12-11-2026", "on 2026-10-31 at the gate", "the 31.12.2026 show"]:
        assert pii.detect(text) == [], text
