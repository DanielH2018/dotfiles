#!/usr/bin/env python3
"""What a create request may ask for — the filter's rules, without any sockets.

Run: python3 test_filter_policy.py

These drive filter_policy.py directly. Nothing here opens a connection, so a
rule is exercised by handing it a decoded body and reading the refusal, which is
the whole reason the rules live in their own module. The transport side — whether
a request reaches these checks at all — is test_docker_create_filter.py.

The last block is the one that matters most and reads the least obviously:
dockerd decodes bodies with Go's encoding/json, which matches field names
case-insensitively and resolves paths before routing. A check that reads exact
keys is vacuous against `{"hostconfig":{"privileged":true}}`, and one that
matches the raw target misses `/v1.43/containers/%63reate`.
"""

import importlib.util
import json
import os
import shutil
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def _canon_lib():
    """canon.py sits somewhere different in each tree this suite runs from.

    Deployed it is under ~/.local/share; in the chezmoi source it is two levels
    up under dot_local; in the filter container both files are bind-mounted flat
    into /opt. Resolving all three is why the deployed copy of this suite used to
    die on import with a path that only ever existed in the source tree.
    """
    for candidate in (
        os.path.join(HERE, "canon.py"),
        os.path.join(HERE, "..", "..", "dot_local", "share", "canon", "canon.py"),
        os.path.expanduser("~/.local/share/canon/canon.py"),
    ):
        if os.path.exists(candidate):
            return os.path.abspath(candidate)
    raise SystemExit(f"{os.path.basename(__file__)}: cannot find canon.py")


os.environ.setdefault("CANON_LIB", _canon_lib())


def _load(filename, modname):
    """Load a sandbox module by path, under its source or deployed name."""
    path = os.path.join(HERE, filename)
    if not os.path.exists(path):
        path = os.path.join(HERE, "executable_" + filename)
    spec = importlib.util.spec_from_file_location(modname, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


policy = _load("filter_policy.py", "filter_policy")

WS = "/workspace/repo"


def scratch_root():
    """A temp dir with no symlink component anywhere in its path.

    The symlink tests below each assert both halves of the rule: a link is refused AND a
    real path under the same workspace is still allowed. On macOS tempfile.mkdtemp() returns
    /var/folders/..., and /var is itself a symlink to /private/var, so every path built from
    it carries a symlink component and the "still allowed" half was denied. The rule under
    test is about links inside the workspace; the fixture must not smuggle one in above it.
    """
    return os.path.realpath(tempfile.mkdtemp())


def denied(path, body):
    """Run one request through the rules; return the message, or None if allowed."""
    policy.WORKSPACE = WS
    payload = body if isinstance(body, bytes) else json.dumps(body).encode()
    try:
        policy.inspect(path, payload)
    except policy.Denied as exc:
        return str(exc)
    return None


def create(host_config):
    return {"Image": "alpine", "HostConfig": host_config}


# --- what a create request may ask for ----------------------------------------


def test_ordinary_compose_create_is_allowed():
    assert (
        denied(
            "/v1.43/containers/create",
            create(
                {
                    "Binds": [f"{WS}/src:/app:rw", "named_vol:/data"],
                    "PortBindings": {"80/tcp": [{"HostPort": "8080"}]},
                    "RestartPolicy": {"Name": "no"},
                }
            ),
        )
        is None
    )


def test_bind_of_host_root_is_refused():
    assert "outside the workspace" in denied(
        "/containers/create", create({"Binds": ["/:/host"]})
    )


def test_bind_of_the_docker_socket_is_refused():
    assert denied(
        "/containers/create",
        create({"Binds": ["/var/run/docker.sock:/var/run/docker.sock"]}),
    )


def test_traversal_out_of_the_workspace_is_refused():
    assert denied("/containers/create", create({"Binds": [f"{WS}/../../etc:/etc"]}))


def test_privileged_is_refused():
    assert "Privileged" in denied("/containers/create", create({"Privileged": True}))


def test_host_namespaces_are_refused():
    for key in ("PidMode", "IpcMode", "UsernsMode", "UTSMode", "CgroupnsMode"):
        assert denied("/containers/create", create({key: "host"})), key


def test_host_and_container_networking_are_refused():
    assert denied("/containers/create", create({"NetworkMode": "host"}))
    assert denied("/containers/create", create({"NetworkMode": "container:other"}))
    # A compose project's own bridge network is the normal case.
    assert denied("/containers/create", create({"NetworkMode": "proj_default"})) is None


def test_capabilities_and_devices_are_refused():
    assert denied("/containers/create", create({"CapAdd": ["SYS_ADMIN"]}))
    assert denied(
        "/containers/create", create({"Devices": [{"PathOnHost": "/dev/sda"}]})
    )
    assert denied("/containers/create", create({"DeviceCgroupRules": ["c 1:* rwm"]}))
    assert denied("/containers/create", create({"VolumesFrom": ["other"]}))


def test_a_non_default_runtime_is_refused():
    assert denied("/containers/create", create({"Runtime": "sysbox-runc"}))
    assert denied("/containers/create", create({"Runtime": "runc"})) is None


def test_confinement_may_be_tightened_but_not_loosened():
    assert (
        denied(
            "/containers/create", create({"SecurityOpt": ["no-new-privileges:true"]})
        )
        is None
    )
    assert denied("/containers/create", create({"SecurityOpt": ["seccomp=unconfined"]}))
    assert denied(
        "/containers/create", create({"SecurityOpt": ["apparmor=unconfined"]})
    )
    assert denied(
        "/containers/create", create({"SecurityOpt": ["systempaths=unconfined"]})
    )


def test_structured_mounts_get_the_same_treatment_as_binds():
    assert (
        denied(
            "/containers/create",
            create(
                {"Mounts": [{"Type": "bind", "Source": f"{WS}/src", "Target": "/app"}]}
            ),
        )
        is None
    )
    assert denied(
        "/containers/create",
        create({"Mounts": [{"Type": "bind", "Source": "/", "Target": "/host"}]}),
    )
    assert (
        denied(
            "/containers/create",
            create({"Mounts": [{"Type": "tmpfs", "Target": "/tmp"}]}),
        )
        is None
    )


def test_a_local_volume_may_not_be_a_bind_in_disguise():
    # `--opt device=/ --opt o=bind` makes a named volume mount the host root.
    assert denied(
        "/containers/create",
        create(
            {
                "Mounts": [
                    {
                        "Type": "volume",
                        "Target": "/host",
                        "VolumeOptions": {
                            "DriverConfig": {"Options": {"device": "/", "o": "bind"}}
                        },
                    }
                ]
            }
        ),
    )
    assert denied(
        "/volumes/create",
        {
            "Name": "escape",
            "Driver": "local",
            "DriverOpts": {"type": "none", "device": "/", "o": "bind"},
        },
    )
    assert denied("/volumes/create", {"Name": "plain"}) is None


def test_a_symlink_out_of_the_workspace_is_resolved_not_trusted():
    # The agent can write to the workspace, so it can drop a symlink to / and bind
    # that. Only realpath catches it — a prefix compare on the literal string does not.
    root = scratch_root()
    try:
        ws = os.path.join(root, "repo")
        os.makedirs(ws)
        os.symlink("/", os.path.join(ws, "escape"))
        policy.WORKSPACE = ws
        try:
            policy.inspect(
                "/containers/create",
                json.dumps(create({"Binds": [f"{ws}/escape:/host"]})).encode(),
            )
            raise AssertionError("symlink to / was accepted")
        except policy.Denied:
            pass
        # A real directory inside the workspace still works.
        os.makedirs(os.path.join(ws, "src"))
        policy.inspect(
            "/containers/create",
            json.dumps(create({"Binds": [f"{ws}/src:/app"]})).encode(),
        )
    finally:
        shutil.rmtree(root)
        policy.WORKSPACE = WS


def test_a_symlink_resolving_INSIDE_the_workspace_is_still_refused():
    # A11-04, and the case the realpath check above cannot reach. This link
    # resolves to a real directory inside the workspace, so `_under_workspace` is
    # satisfied and the bind was accepted. But the filter decides at container-
    # CREATE and dockerd resolves again at container-START, and the agent can write
    # to the workspace in between — so between those two moments the link can be
    # re-pointed at /. Nothing about the create-time answer survives that.
    #
    # The fix denies any source with a symlink component, removing the window
    # instead of narrowing it: a path with no link in it has nothing to swap.
    root = scratch_root()
    try:
        ws = os.path.join(root, "repo")
        os.makedirs(os.path.join(ws, "real"))
        os.symlink(os.path.join(ws, "real"), os.path.join(ws, "inside"))
        policy.WORKSPACE = ws
        msg = ""
        try:
            policy.inspect(
                "/containers/create",
                json.dumps(create({"Binds": [f"{ws}/inside:/app"]})).encode(),
            )
            raise AssertionError("a swappable symlink in the workspace was accepted")
        except policy.Denied as exc:
            msg = str(exc)
        assert "symlink component" in msg, msg

        # The same applies one level down: the link need not be the last component.
        try:
            policy.inspect(
                "/containers/create",
                json.dumps(create({"Binds": [f"{ws}/inside/deeper:/app"]})).encode(),
            )
            raise AssertionError("a symlink parent component was accepted")
        except policy.Denied:
            pass

        # A real path with no link anywhere in it is still allowed — the trade is that a
        # legitimately symlinked workspace path now has to be named by its real path.
        policy.inspect(
            "/containers/create",
            json.dumps(create({"Binds": [f"{ws}/real:/app"]})).encode(),
        )
    finally:
        shutil.rmtree(root)
        policy.WORKSPACE = WS


def test_the_symlink_component_rule_covers_structured_mounts_too():
    # Binds and Mounts are two spellings of one thing, and a rule applied to only one of
    # them is a rule with a documented bypass.
    root = scratch_root()
    try:
        ws = os.path.join(root, "repo")
        os.makedirs(os.path.join(ws, "real"))
        os.symlink(os.path.join(ws, "real"), os.path.join(ws, "inside"))
        policy.WORKSPACE = ws
        msg = ""
        try:
            policy.inspect(
                "/containers/create",
                json.dumps(
                    create(
                        {
                            "Mounts": [
                                {
                                    "Type": "bind",
                                    "Source": f"{ws}/inside",
                                    "Target": "/app",
                                }
                            ]
                        }
                    )
                ).encode(),
            )
            raise AssertionError("a swappable symlink reached /app via Mounts")
        except policy.Denied as exc:
            msg = str(exc)
        assert "symlink component" in msg, msg
    finally:
        shutil.rmtree(root)
        policy.WORKSPACE = WS


def test_a_hostconfig_on_start_is_refused():
    # Pre-1.24 daemons honour a HostConfig on start, which would reinstate everything
    # rejected at create time. Nothing legitimate sends a body here.
    assert denied("/v1.20/containers/abc/start", {"Privileged": True})
    assert denied("/containers/abc/start", b"") is None
    assert denied("/containers/abc/start", b"{}") is None


def test_unrelated_endpoints_are_not_inspected():
    for path in (
        "/containers/json",
        "/v1.43/images/json",
        "/networks/create",
        "/_ping",
    ):
        assert denied(path, {"anything": True}) is None


def test_an_unparseable_create_body_is_refused_not_guessed():
    assert denied("/containers/create", b"{not json")
    assert denied("/containers/create", b"[]")


# --- the decision must rest on the form dockerd will act on -------------------


def test_lowercase_hostconfig_is_still_inspected():
    # Go's encoding/json matches struct fields case-insensitively, so dockerd populates
    # HostConfig.Privileged from this body while an exact-key lookup saw nothing at all.
    body = {"Image": "alpine", "hostconfig": {"privileged": True, "binds": ["/:/host"]}}
    assert denied("/v1.43/containers/create", body)


def test_mixed_case_hostconfig_keys_are_still_inspected():
    assert denied("/v1.43/containers/create", create({"PrIvIlEgEd": True}))
    assert denied("/v1.43/containers/create", create({"BINDS": ["/etc:/etc"]}))
    assert denied("/v1.43/containers/create", create({"pidmode": "host"}))


def test_ambiguous_sibling_keys_are_refused_not_guessed():
    # Two keys folding together have no single meaning: Go resolves them by struct
    # field declaration order, which cannot be modelled here.
    body = {"Image": "alpine", "HostConfig": {}, "hostconfig": {"privileged": True}}
    assert denied("/v1.43/containers/create", body)


def test_lowercase_mount_type_bind_is_checked_as_a_bind():
    # A mount whose Type key missed the exact-case lookup fell through to the "volume"
    # default and was never checked against the workspace.
    mount = {"type": "bind", "source": "/", "target": "/host"}
    assert denied("/v1.43/containers/create", create({"Mounts": [mount]}))


def test_uppercase_mount_type_value_is_not_an_unknown_type():
    mount = {"Type": "BIND", "Source": "/", "Target": "/host"}
    assert denied("/v1.43/containers/create", create({"Mounts": [mount]}))


def test_bind_mount_inside_the_workspace_still_allowed():
    mount = {"type": "bind", "source": WS + "/sub", "target": "/x"}
    assert denied("/v1.43/containers/create", create({"Mounts": [mount]})) is None


def test_percent_encoded_create_path_is_inspected():
    # /containers/%63reate reaches the create handler but never matched CREATE_RE.
    assert denied("/v1.43/containers/%63reate", create({"Privileged": True}))


def test_dot_segment_create_path_is_inspected():
    assert denied("/v1.43/containers/./create", create({"Privileged": True}))
    assert denied("/v1.43/foo/../containers/create", create({"Privileged": True}))


def test_doubly_encoded_path_is_refused():
    # %2563 -> %63 after one pass; decoding to a fixpoint is its own bypass class, so
    # a target still holding an escape is refused rather than decoded again.
    assert denied("/v1.43/containers/%2563reate", create({}))


def test_labels_and_env_keys_are_left_alone():
    # cfget is a lookup, not a recursive fold: these keys are user data and folding
    # them would corrupt a legitimate request.
    body = {
        "Image": "alpine",
        "Labels": {"com.example.Foo": "1", "com.example.foo": "2"},
        "Env": ["Path=/x"],
        "HostConfig": {"Binds": [WS + ":/w"]},
    }
    assert denied("/v1.43/containers/create", body) is None


if __name__ == "__main__":
    ran = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            ran += 1
    print(f"OK {ran}")
