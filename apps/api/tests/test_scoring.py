"""Simple detector tests — run from apps/api: pytest"""

from app.services.scoring import score_input


def test_vague_prompt_scores_low():
    r = score_input(
        "Hi, please carefully and thoroughly explain everything in as much detail as possible. Thanks!"
    )
    assert r["input_score"] < 70
    ids = {f.id for f in r["findings"]}
    assert "P01" in ids or "P02" in ids or "P10" in ids


def test_strong_prompt_scores_high():
    r = score_input(
        "Compare merge sort and quicksort for n=10^6 integers.\n"
        "Return a markdown table with columns: algorithm, avg time, worst time, extra memory.\n"
        "Max 8 bullet notes after the table."
    )
    assert r["input_score"] >= 70
