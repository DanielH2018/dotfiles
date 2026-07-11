from config_map.model import semantic_payload
from config_map.render import render
from config_map.scan import build_setup_map


def test_two_runs_produce_identical_semantic_payload(fake_env):
    first = semantic_payload(build_setup_map())
    second = semantic_payload(build_setup_map())
    assert first == second


def test_two_runs_produce_identical_html_modulo_generated_at(fake_env):
    map_a = build_setup_map()
    map_b = build_setup_map()
    html_a = render(map_a).replace(map_a.generated_at, "TIMESTAMP")
    html_b = render(map_b).replace(map_b.generated_at, "TIMESTAMP")
    assert html_a == html_b


def test_semantic_payload_excludes_volatile_fields(fake_env):
    setup_map = build_setup_map()
    payload = semantic_payload(setup_map)
    assert "generated_at" not in payload
    assert "source_shas" not in payload
