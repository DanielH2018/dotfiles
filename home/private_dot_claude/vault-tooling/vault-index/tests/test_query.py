from vault_index.query import rrf_fuse


def test_rrf_rewards_agreement_across_lists():
    # "b" is ranked well in both lists; should win.
    vec = ["a", "b", "c"]
    bm25 = ["b", "d", "a"]
    scores = rrf_fuse([vec, bm25])
    ranked = sorted(scores, key=lambda c: scores[c], reverse=True)
    assert ranked[0] == "b"


def test_rrf_top_of_single_list_beats_absent():
    scores = rrf_fuse([["x", "y"], ["x", "z"]])
    assert scores["x"] > scores["y"]
    assert scores["x"] > scores["z"]


def test_rrf_empty():
    assert rrf_fuse([]) == {}
