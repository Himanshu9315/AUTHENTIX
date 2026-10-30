import pytest

from app import guard

BASE = "https://authentix.in"


@pytest.mark.parametrize(
    "answer",
    [
        "Click https://authentix.in.evil.test/free now",  # our name used as a prefix of someone else's host
        "Click https://authentix.in@evil.test/free now",
        "see evil.test/free",
        "visit www.evil.com today",
        "go to //evil.test/x",
        "[here](https://evil.test/pay)",
        "javascript:alert(1)",
        "data:text/html;base64,AAAA",
        "visit evil.com",
        "go to evil.ru", "go to evil.zip", "go to evil[.]test", "go to evil . test", "go to evil(.)test",
    ],
)
def test_links_to_other_sites_are_removed_in_every_form(answer):
    text, _ = guard.apply(answer, BASE)
    assert "evil" not in text.lower() and "javascript" not in text.lower() and "data:" not in text.lower()


def test_our_own_links_and_the_support_address_survive():
    text, redirect = guard.apply("See https://authentix.in/tickets or email support@authentix.test for help.", BASE)
    assert "https://authentix.in/tickets" in text and "support@authentix.test" in text and not redirect


def test_our_own_link_with_a_port_number_does_not_look_like_a_made_up_figure():
    text, redirect = guard.apply("Open http://localhost:8080/tickets to see them.", "http://localhost:8080")
    assert "localhost:8080/tickets" in text and not redirect


@pytest.mark.parametrize(
    "answer",
    [
        "INR1499 only", "INR 1,499", "Rs.999 for general", "₹ 1,499", "1499/-", "that's 999 rupees",
        "tickets cost 1499", "It is sold-out", "sold out", "tickets are available", "seats are still available", "only 3 left",
        "doors at 6", "7 o'clock sharp", "at 7pm", "starts 7.30", "on 14 November", "November 2026", "Saturday evening", "12/11/2026",
        "about 1.5k", "at 7p.m.", "at 19h", "tomorrow at 7", "on the 5th", "next Friday", "free tickets for all", "selling fast",
        "a few tickets remain", "fifteen hundred", "two thousand",
    ],
)
def test_prices_dates_and_availability_in_a_model_answer_are_always_replaced(answer):
    text, redirect = guard.apply(answer, BASE)
    assert text == guard.REDIRECT and redirect


@pytest.mark.parametrize("answer", ["You can transfer a ticket twice.", "Transfers close 24 hours before the event.", "Mark 4 tickets as the limit.", "The hold lasts 8 minutes.", "A code changes every 30 seconds.", "You may 2 transfer"])
def test_ordinary_help_answers_are_not_blocked(answer):
    text, redirect = guard.apply(answer, BASE)
    assert text == answer and not redirect


def test_an_answer_with_personal_data_is_withheld():
    assert guard.apply("Your number 1000 0000 0001 is fine.", BASE)[0] == guard.SAFE_FALLBACK
    assert guard.apply("Write to someone@example.test", BASE)[0] == guard.SAFE_FALLBACK


def test_the_support_address_is_allowed_in_any_case_but_only_as_a_whole_address():
    assert guard.apply("Email SUPPORT@authentix.test please.", BASE)[0].lower() == "email support@authentix.test please."  # shown in its normal lower case
    assert guard.apply("Email xsupport@authentix.test please.", BASE)[0] == guard.SAFE_FALLBACK
