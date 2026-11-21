"""`k8s-rollout` and `k8s-field` against a fake `kubectl`: its output in, a state out.

The objects carry only the fields the source reads, in the shapes a live k3s cluster returned
on 2026-10-04 (homepage's Deployment and ReplicaSets, alloy's DaemonSet and pods).
"""

import json
import subprocess

import pytest

from cc_wait import k8s
from cc_wait.source import ReadError, SourceError, validate

UID = "dep-uid"


def kubectl(obj: dict, items: list[dict] | None = None, calls: list | None = None):
    """A runner answering `get <kind>/<name>` with `obj` and any list `get` with `items`."""

    def run(cmd, **_kwargs):
        if calls is not None:
            calls.append(cmd)
        target = cmd[cmd.index("get") + 1]
        body = obj if "/" in target else {"kind": "List", "items": items or []}
        return subprocess.CompletedProcess(cmd, 0, json.dumps(body), "")

    return run


def read(kind: str, obj: dict, items: list[dict] | None = None):
    wait = k8s.RolloutWait(kind, "app", "homelab", None, kubectl(obj, items))
    validate(wait.describe())
    return wait.read()


def deployment(*, gen=2, observed=2, want=1, updated=1, total=1, available=1, conditions=()):
    return {
        "kind": "Deployment",
        "metadata": {
            "uid": UID,
            "generation": gen,
            "annotations": {"deployment.kubernetes.io/revision": "76"},
        },
        "spec": {"replicas": want, "selector": {"matchLabels": {"app": "app"}}},
        "status": {
            "observedGeneration": observed,
            "replicas": total,
            "updatedReplicas": updated,
            "availableReplicas": available,
            "conditions": list(conditions),
        },
    }


def replicaset(revision: str, pod_hash: str):
    return {
        "kind": "ReplicaSet",
        "metadata": {
            "annotations": {"deployment.kubernetes.io/revision": revision},
            "labels": {"pod-template-hash": pod_hash},
            "ownerReferences": [{"uid": UID}],
        },
    }


def pod(labels: dict, reason: str | None = None, restarts: int = 0, name: str = "app-x"):
    status = {"containerStatuses": [{"name": "app", "restartCount": restarts, "state": {}}]}
    if reason:
        status["containerStatuses"][0]["state"] = {"waiting": {"reason": reason}}
    return {"kind": "Pod", "metadata": {"name": name, "labels": labels}, "status": status}


def test_parse_object_reads_the_fields_once_and_defaults_the_absent_ones():
    cond = {"type": "Progressing", "status": "True", "reason": "NewReplicaSetAvailable"}
    parsed = k8s.parse_object(deployment(gen=3, observed=2, want=4, updated=3, conditions=[cond]))
    assert (parsed.generation, parsed.observed_generation) == (3, 2)
    assert (parsed.want_replicas, parsed.updated_replicas, parsed.ready_replicas) == (4, 3, 0)
    assert parsed.selector == {"app": "app"}
    assert parsed.condition("Progressing") == k8s.Condition(
        "Progressing", "True", "NewReplicaSetAvailable", None
    )
    assert parsed.condition("Available") is None

    bare = k8s.parse_object({"metadata": None, "status": None})
    assert (bare.generation, bare.want_replicas, bare.name, bare.update_type) == (
        0,
        1,
        "?",
        "RollingUpdate",
    )
    assert bare.conditions == () and bare.selector == {}


def test_parse_object_lists_init_containers_before_containers_with_their_wait_reason():
    raw = pod({"app": "x"}, reason="CrashLoopBackOff", restarts=5)
    raw["status"]["initContainerStatuses"] = [{"name": "init", "state": {}}]
    raw["status"]["containerStatuses"][0]["state"]["waiting"]["message"] = " back-off \n"
    parsed = k8s.parse_object(raw)
    assert [c.name for c in parsed.containers] == ["init", "app"]
    assert parsed.containers[0].waiting_reason is None
    assert parsed.containers[1] == k8s.Container("app", 5, "CrashLoopBackOff", "back-off")


def test_a_rolled_out_deployment_ends_rolled_out():
    assert read("deployment", deployment()).state == "rolled-out"


def test_a_status_older_than_the_spec_is_not_judged():
    reading = read("deployment", deployment(gen=3, observed=2))
    assert reading.state == "running"
    assert "generation 3" in reading.detail


def test_a_deployment_still_updating_is_running():
    assert read("deployment", deployment(want=2, updated=1, total=2)).state == "running"


def test_the_progress_deadline_fails_a_deployment():
    cond = {"type": "Progressing", "status": "False", "reason": "ProgressDeadlineExceeded"}
    assert read("deployment", deployment(available=0, conditions=[cond])).state == "failed"


def test_a_new_pod_crash_looping_fails_the_rollout():
    items = [
        replicaset("75", "old"),
        replicaset("76", "new"),
        pod({"pod-template-hash": "new"}, "CrashLoopBackOff", restarts=3),
    ]
    reading = read("deployment", deployment(available=0), items)
    assert reading.state == "failed"
    assert "CrashLoopBackOff after 3 restarts" in reading.detail


def test_an_old_pod_crash_looping_does_not_fail_the_rollout_that_replaces_it():
    items = [
        replicaset("75", "old"),
        replicaset("76", "new"),
        pod({"pod-template-hash": "old"}, "CrashLoopBackOff", restarts=40, name="app-old"),
        pod({"pod-template-hash": "new"}, "ContainerCreating", name="app-new"),
    ]
    assert read("deployment", deployment(total=2, available=0), items).state == "running"


def test_a_first_crash_is_not_yet_a_crash_loop():
    items = [replicaset("76", "new"), pod({"pod-template-hash": "new"}, "CrashLoopBackOff", 1)]
    reading = read("deployment", deployment(available=0), items)
    assert reading.state == "running"
    assert "CrashLoopBackOff after 1 restarts" in reading.detail


def test_a_reason_that_can_clear_is_shown_but_does_not_end_the_wait():
    items = [replicaset("76", "new"), pod({"pod-template-hash": "new"}, "ErrImagePull")]
    reading = read("deployment", deployment(available=0), items)
    assert reading.state == "running"
    assert "ErrImagePull" in reading.detail


def daemonset(*, want=2, updated=2, available=2):
    return {
        "kind": "DaemonSet",
        "metadata": {
            "generation": 10,
            "annotations": {"deprecated.daemonset.template.generation": "10"},
        },
        "spec": {
            "selector": {"matchLabels": {"app": "app"}},
            "updateStrategy": {"type": "RollingUpdate"},
        },
        "status": {
            "observedGeneration": 10,
            "desiredNumberScheduled": want,
            "updatedNumberScheduled": updated,
            "numberAvailable": available,
        },
    }


def test_a_daemonset_has_no_deadline_so_its_new_pods_fail_it():
    items = [
        pod({"pod-template-generation": "9"}, "CrashLoopBackOff", 9, name="old"),
        pod({"pod-template-generation": "10"}, "ImagePullBackOff", name="new"),
    ]
    reading = read("daemonset", daemonset(updated=1, available=1), items)
    assert reading.state == "failed"
    assert reading.detail.startswith("new/app: ImagePullBackOff")


def test_a_daemonset_with_every_pod_updated_and_available_rolled_out():
    assert read("daemonset", daemonset()).state == "rolled-out"


def statefulset(*, want=1, ready=1, updated=1, current="r1", update="r1"):
    return {
        "kind": "StatefulSet",
        "metadata": {"generation": 4},
        "spec": {
            "replicas": want,
            "selector": {"matchLabels": {"app": "app"}},
            "updateStrategy": {"type": "RollingUpdate"},
        },
        "status": {
            "observedGeneration": 4,
            "readyReplicas": ready,
            "updatedReplicas": updated,
            "currentRevision": current,
            "updateRevision": update,
        },
    }


def test_a_statefulset_new_revision_pod_crash_looping_fails_it():
    items = [pod({"controller-revision-hash": "r2"}, "CrashLoopBackOff", 5)]
    reading = read("statefulset", statefulset(ready=0, update="r2"), items)
    assert reading.state == "failed"


def test_a_statefulset_mid_revision_is_running_then_rolled_out():
    assert read("statefulset", statefulset(update="r2")).state == "running"
    assert read("statefulset", statefulset()).state == "rolled-out"


def job(conditions=(), **status):
    return {
        "kind": "Job",
        "metadata": {"generation": 1},
        "spec": {"selector": {"matchLabels": {"batch.kubernetes.io/controller-uid": "u"}}},
        "status": {"conditions": list(conditions), **status},
    }


def test_a_job_ends_on_its_complete_or_failed_condition():
    done = {"type": "Complete", "status": "True"}
    failed = {"type": "Failed", "status": "True", "message": "BackoffLimitExceeded"}
    assert read("job", job([done])).state == "complete"
    reading = read("job", job([failed]))
    assert (reading.state, reading.detail) == ("failed", "BackoffLimitExceeded")


def test_a_job_whose_pod_cannot_pull_fails_without_waiting_for_its_backoff_limit():
    items = [pod({"batch.kubernetes.io/controller-uid": "u"}, "ImagePullBackOff")]
    assert read("job", job(active=1), items).state == "failed"


def test_an_ondelete_statefulset_cannot_be_waited_on():
    obj = statefulset()
    obj["spec"]["updateStrategy"] = {"type": "OnDelete"}
    with pytest.raises(ReadError, match="OnDelete"):
        read("statefulset", obj)


def test_bind_takes_kubectl_short_kinds_and_refuses_others():
    wait = k8s.RolloutSource().bind(["deploy/homepage", "-n", "homelab"])
    assert (wait.kind, wait.name, wait.namespace) == ("deployment", "homepage", "homelab")
    with pytest.raises(SourceError, match="KIND/NAME"):
        k8s.RolloutSource().bind(["cronjob/x"])


# `k8s-field`. The stderr lines are what the homelab's read-only ServiceAccount got back on
# 2026-11-14.
NOT_FOUND = 'Error from server (NotFound): volumes.longhorn.io "pvc-1" not found'
FORBIDDEN = (
    'Error from server (Forbidden): secrets "x" is forbidden: User '
    '"system:serviceaccount:kube-system:homelab-readonly" cannot get resource "secrets"'
)


def field_read(stdout: str = "", stderr: str = "", rc: int = 0, fail=(), calls=None):
    def run(cmd, **_kwargs):
        if calls is not None:
            calls.append(cmd)
        return subprocess.CompletedProcess(cmd, rc, stdout, stderr)

    wait = k8s.FieldWait(
        "volumes.longhorn.io/pvc-1", "{.status.state}", "detached", tuple(fail), "ls", None, run
    )
    validate(wait.describe())
    return wait.read()


def test_the_field_reading_the_value_matches_through_one_jsonpath_get():
    calls = []
    assert field_read("detached", calls=calls).state == "matched"
    assert calls == [
        [
            "kubectl",
            "--namespace",
            "ls",
            "get",
            "volumes.longhorn.io/pvc-1",
            "--output",
            "jsonpath={.status.state}",
        ]
    ]


def test_another_value_or_an_unset_key_keeps_the_wait_open():
    reading = field_read("attached")
    assert reading.state == "waiting"
    assert "'attached'" in reading.detail
    assert field_read("").state == "waiting"


def test_a_fail_value_ends_the_wait_failed():
    assert field_read("faulted", fail=["faulted"]).state == "failed"


def test_a_forbidden_read_is_a_failed_read_never_a_match():
    with pytest.raises(ReadError, match="Forbidden"):
        field_read(stderr=FORBIDDEN, rc=1)


def test_an_object_that_does_not_exist_ends_the_wait_not_found():
    reading = field_read(stderr=NOT_FOUND, rc=1)
    assert reading.state == "not-found"


def test_field_bind_refuses_a_bad_target_a_bare_path_or_a_value_that_is_also_a_failure():
    source = k8s.FieldSource()
    wait = source.bind(
        [
            "backuptargets.longhorn.io/default",
            "{.status.available}",
            "--equals",
            "true",
            "-n",
            "longhorn-system",
        ]
    )
    assert (wait.target, wait.equals) == ("backuptargets.longhorn.io/default", "true")
    with pytest.raises(SourceError, match="RESOURCE/NAME"):
        source.bind(["pvc-1", "{.status.state}", "--equals", "detached"])
    with pytest.raises(SourceError, match="jsonpath template"):
        source.bind(["volumes.longhorn.io/pvc-1", ".status.state", "--equals", "detached"])
    with pytest.raises(SourceError, match="both"):
        source.bind(
            ["volumes.longhorn.io/pvc-1", "{.status.state}", "--equals", "x", "--fail", "x"]
        )
