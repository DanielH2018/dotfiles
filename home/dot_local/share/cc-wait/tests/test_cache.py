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


def test_a_second_waiter_inside_the_window_reads_the_first_waiter_s_result(tmp_path):
    read = Counter(Reading("running", "1/2"), Reading("passed", "2/2"))
    now = [1000.0]
    first = cached_read("k", 27, read, tmp_path, clock=lambda: now[0])
    now[0] += 10
    second = cached_read("k", 27, read, tmp_path, clock=lambda: now[0])
    assert first == second == Reading("running", "1/2")
    assert read.calls == 1


def test_a_waiter_past_the_window_reads_again(tmp_path):
    read = Counter(Reading("running", "1/2"), Reading("passed", "2/2"))
    cached_read("k", 27, read, tmp_path, clock=lambda: 1000.0)
    later = cached_read("k", 27, read, tmp_path, clock=lambda: 10_000_000_000.0)
    assert later == Reading("passed", "2/2")
    assert read.calls == 2


def test_a_failed_read_is_not_cached(tmp_path):
    read = Counter(ReadError("blip"), Reading("passed", "ok"))
    with pytest.raises(ReadError):
        cached_read("k", 27, read, tmp_path)
    assert cached_read("k", 27, read, tmp_path) == Reading("passed", "ok")


def test_two_keys_do_not_share_a_result(tmp_path):
    cached_read("pr 1", 27, Counter(Reading("open")), tmp_path)
    assert cached_read("pr 2", 27, Counter(Reading("merged")), tmp_path).state == "merged"
