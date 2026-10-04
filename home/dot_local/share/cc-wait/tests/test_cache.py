import pytest

from cc_wait.cache import cached_read
from cc_wait.source import ReadError, Reading


class Counter:
    def __init__(self, *results):
        self.results = list(results)
        self.calls = 0

    def __call__(self):
        self.calls += 1
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def written_at(directory) -> float:
    """The mtime of the one cached result in `directory`, which the window is measured from."""
    (path,) = directory.glob("*.json")
    return path.stat().st_mtime


def test_a_second_waiter_inside_the_window_reads_the_first_waiter_s_result(tmp_path):
    read = Counter(Reading("running", "1/2"), Reading("passed", "2/2"))
    first = cached_read("k", 27, read, tmp_path)
    at = written_at(tmp_path)
    second = cached_read("k", 27, read, tmp_path, clock=lambda: at + 26)
    assert first == second == Reading("running", "1/2")


def test_a_waiter_past_the_window_reads_again(tmp_path):
    read = Counter(Reading("running", "1/2"), Reading("passed", "2/2"))
    cached_read("k", 27, read, tmp_path)
    at = written_at(tmp_path)
    later = cached_read("k", 27, read, tmp_path, clock=lambda: at + 28)
    assert later == Reading("passed", "2/2")


def test_a_failed_read_is_not_cached(tmp_path):
    read = Counter(ReadError("blip"), Reading("passed", "ok"))
    with pytest.raises(ReadError):
        cached_read("k", 27, read, tmp_path)
    assert cached_read("k", 27, read, tmp_path) == Reading("passed", "ok")


def test_two_keys_do_not_share_a_result(tmp_path):
    cached_read("pr 1", 27, Counter(Reading("open")), tmp_path)
    assert cached_read("pr 2", 27, Counter(Reading("merged")), tmp_path).state == "merged"
