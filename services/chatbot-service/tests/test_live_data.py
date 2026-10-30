import asyncio
import re

from app.guard import REDIRECT
from app.models import ChatRequest, ModelAnswer
from app.service import LIVE_DOWN, WHICH_EVENT, ChatService
from tests.fakes import EVENTS, FAQ, FakeLive, FakeLLM, FakeStore, settings


def run(svc, message, slug=None):
    req = ChatRequest.model_validate({"message": message, **({"context": {"eventSlug": slug}} if slug else {})})
    return asyncio.run(svc.chat(req, "0123456789abcdef"))


def svc(live=None, llm=None):
    return ChatService(settings(), FakeStore(FAQ + EVENTS), llm or FakeLLM(), live or FakeLive())


def test_a_price_question_on_an_event_page_is_answered_from_live_data_and_the_model_is_not_called():
    llm = FakeLLM()
    r = run(svc(llm=llm), "How much is a ticket?", slug="neon-monsoon-live-gurugram")
    assert llm.calls == 0
    assert [(t.name, t.priceInr) for t in r.liveData.tiers] == [("General", 1499), ("Premium", 2999)]
    assert r.liveData.event.title == "Neon Monsoon Live"
    assert not re.search(r"\d", r.answer), "the sentence itself carries no numbers: they come only from liveData"
    assert r.flags.grounded


def test_availability_comes_from_inventory_not_from_text():
    r = run(svc(), "Are tickets still available?", slug="neon-monsoon-live-gurugram")
    assert [(t.name, t.available) for t in r.liveData.tiers] == [("General", 120), ("Premium", 0)]
    r2 = run(svc(), "How much is a ticket?", slug="neon-monsoon-live-gurugram")
    assert [t.available for t in r2.liveData.tiers] == [None, None]  # stock is only fetched when asked about


def test_a_whole_event_title_in_the_question_finds_the_event():
    r = run(svc(), "what is the price for Neon Monsoon Live?")
    assert r.liveData and r.liveData.event.slug == "neon-monsoon-live-gurugram"


def test_catalog_down_means_no_numbers_at_all():
    r = run(svc(live=FakeLive(down=True)), "How much is a ticket?", slug="neon-monsoon-live-gurugram")
    assert r.answer == LIVE_DOWN
    assert r.liveData is None
    assert not re.search(r"\d", r.answer)


def test_two_events_named_in_one_question_asks_which_one():
    r = run(svc(), "price for Neon Monsoon Live or Echo Bazaar Night?")
    assert "Did you mean" in r.answer and r.liveData is None
    assert {s.title for s in r.sources} == {"Neon Monsoon Live", "Echo Bazaar Night"}


def test_a_price_question_with_no_event_asks_which_event_and_never_guesses():
    llm = FakeLLM()
    r = run(svc(llm=llm), "how much does a ticket cost?")
    assert r.answer == WHICH_EVENT and llm.calls == 0


def test_a_help_question_that_merely_mentions_time_still_gets_a_help_answer():
    llm = FakeLLM()
    r = run(svc(llm=llm), "How long do I have before the transfer window closes?")
    assert llm.answer_calls and r.liveData is None


def test_a_model_answer_that_quotes_a_price_is_replaced():
    llm = FakeLLM(reply=lambda turn: ModelAnswer(answer="Tickets cost ₹999 each.", used_source_ids=["S1"]))
    r = run(svc(llm=llm), "How do transfers work?")
    assert r.answer == REDIRECT and r.flags.liveDataRedirect and r.sources == []


def test_a_model_answer_with_a_date_or_availability_claim_is_replaced():
    for bad in ["The show starts at 7:30 pm.", "It is on 14 November.", "Only 3 tickets left!", "It is sold out."]:
        llm = FakeLLM(reply=lambda turn, bad=bad: ModelAnswer(answer=bad, used_source_ids=[]))
        assert run(svc(llm=llm), "How do transfers work?").answer == REDIRECT, bad


def test_help_questions_that_mention_fee_time_or_hold_get_help_answers_even_on_an_event_page():
    for question in ["Is there a fee to transfer a ticket?", "How long is the seat hold?", "What time does my hold expire?", "What happens when the booking timer ends?"]:
        llm = FakeLLM()
        r = run(svc(llm=llm), question, slug="neon-monsoon-live-gurugram")
        assert r.liveData is None and llm.answer_calls, question


def test_a_clear_price_question_still_gets_live_data_on_an_event_page():
    r = run(svc(), "how much is a ticket, and is there a transfer fee?", slug="neon-monsoon-live-gurugram")
    assert r.liveData is not None


def test_two_events_with_the_same_title_are_ambiguous_not_unknown():
    twin = dict(EVENTS[0], id="event:neon-monsoon-live-pune", path="/events/neon-monsoon-live-pune")
    s = ChatService(settings(), FakeStore(FAQ + EVENTS + [twin]), FakeLLM(), FakeLive())
    r = run(s, "how much is neon monsoon live")
    assert "Did you mean" in r.answer and r.liveData is None
    assert {x.path for x in r.sources} == {"/events/neon-monsoon-live-gurugram", "/events/neon-monsoon-live-pune"}
