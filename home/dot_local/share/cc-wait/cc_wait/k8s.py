"""The `k8s-rollout` source: a workload finishes rolling out, or a Job finishes.

`cc-wait k8s-rollout <kind>/<name> [-n NAMESPACE] [--context CONTEXT]` takes a Deployment,
StatefulSet or DaemonSet (judged as `kubectl rollout status` judges it), or a Job:

    rolled-out  0   every replica runs the new template and is available
    complete    0   the Job's Complete condition is True
    failed      1   the progress deadline passed, the Job failed, or a new pod cannot run

WHAT IT ADDS TO `kubectl rollout status`: a pod of the NEW revision that cannot run fails the
wait at once. `rollout status` fails a Deployment only when its progress deadline passes (600s
by default) and a StatefulSet or DaemonSet never. Only the new revision's pods count, because
an old pod crash-looping is often the reason for the rollout being waited on.

WHICH POD REASONS END THE WAIT. A reason that cannot clear on its own does: ImagePullBackOff
(a pull already failed and is being retried), InvalidImageName, and CrashLoopBackOff once the
container has restarted CRASH_LOOP_RESTARTS times. A first crash while a dependency starts is
common and recovers, so fewer restarts do not count. ErrImagePull (the image may still be
pushing) and CreateContainerConfigError (its Secret may still be applying) can clear, so they
appear in the `running` detail and the wait continues.

Every read is two `kubectl get` calls: the object, then its pods (and, for a Deployment, its
ReplicaSets, which name the new revision). It needs get and list on those kinds, nothing more.
"""

import json
import re
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field

from cc_wait.source import ArgParser, Description, ReadError, Reading

INTERVAL_S = 10.0
KUBECTL_TIMEOUT_S = 30
CRASH_LOOP_RESTARTS = 3
FATAL_REASONS = frozenset({"ImagePullBackOff", "InvalidImageName"})
# Waiting reasons that are the normal path to running, never worth a line of detail.
ROUTINE_REASONS = frozenset({"ContainerCreating", "PodInitializing"})

KINDS = {
    "deployment": "deployment",
    "deployments": "deployment",
    "deploy": "deployment",
    "statefulset": "statefulset",
    "statefulsets": "statefulset",
    "sts": "statefulset",
    "daemonset": "daemonset",
    "daemonsets": "daemonset",
    "ds": "daemonset",
    "job": "job",
    "jobs": "job",
}
_NAME = re.compile(r"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$")

Runner = Callable[..., subprocess.CompletedProcess]


def _status(obj: dict) -> dict:
    return obj.get("status") or {}


def _labels(obj: dict) -> dict:
    return (obj.get("metadata") or {}).get("labels") or {}


def _annotation(obj: dict, key: str) -> str | None:
    return ((obj.get("metadata") or {}).get("annotations") or {}).get(key)


def _condition(obj: dict, kind: str) -> dict | None:
    for cond in _status(obj).get("conditions") or []:
        if cond.get("type") == kind:
            return cond
    return None


def pod_problems(pods: list[dict]) -> tuple[str | None, list[str]]:
    """The first fatal container problem among `pods`, and every other non-routine one."""
    notes: list[str] = []
    for pod in pods:
        name = (pod.get("metadata") or {}).get("name", "?")
        status = _status(pod)
        for cs in (status.get("initContainerStatuses") or []) + (
            status.get("containerStatuses") or []
        ):
            waiting = (cs.get("state") or {}).get("waiting") or {}
            reason = waiting.get("reason")
            if not reason or reason in ROUTINE_REASONS:
                continue
            restarts = cs.get("restartCount", 0)
            line = f"{name}/{cs.get('name', '?')}: {reason}"
            if reason == "CrashLoopBackOff":
                line += f" after {restarts} restarts"
            fatal = reason in FATAL_REASONS or (
                reason == "CrashLoopBackOff" and restarts >= CRASH_LOOP_RESTARTS
            )
            if fatal:
                message = (waiting.get("message") or "").strip()
                return f"{line}: {message}"[:400] if message else line, notes
            notes.append(line)
    return None, notes


def _deployment_progress(obj: dict) -> Reading:
    spec, status = obj.get("spec") or {}, _status(obj)
    progressing = _condition(obj, "Progressing")
    if progressing and progressing.get("reason") == "ProgressDeadlineExceeded":
        return Reading("failed", f"progress deadline exceeded: {progressing.get('message', '')}")
    want = spec.get("replicas", 1)
    updated = status.get("updatedReplicas", 0)
    total = status.get("replicas", 0)
    available = status.get("availableReplicas", 0)
    if updated < want:
        return Reading("running", f"{updated} of {want} replicas updated")
    if total > updated:
        return Reading("running", f"{total - updated} old replicas pending termination")
    if available < updated:
        return Reading("running", f"{available} of {updated} updated replicas available")
    return Reading("rolled-out", f"{updated} of {want} replicas updated and available")


def _statefulset_progress(obj: dict) -> Reading:
    spec, status = obj.get("spec") or {}, _status(obj)
    strategy = spec.get("updateStrategy") or {}
    if strategy.get("type", "RollingUpdate") != "RollingUpdate":
        raise ReadError("an OnDelete StatefulSet has no rollout to wait on")
    want = spec.get("replicas", 1)
    ready = status.get("readyReplicas", 0)
    updated = status.get("updatedReplicas", 0)
    if ready < want:
        return Reading("running", f"{ready} of {want} pods ready")
    partition = (strategy.get("rollingUpdate") or {}).get("partition") or 0
    if partition:
        if updated < want - partition:
            return Reading("running", f"{updated} of {want - partition} partitioned pods updated")
        return Reading("rolled-out", f"partitioned roll out complete: {updated} pods updated")
    if status.get("updateRevision") != status.get("currentRevision"):
        return Reading("running", f"{updated} of {want} pods at the new revision")
    return Reading("rolled-out", f"{want} of {want} pods ready at the new revision")


def _daemonset_progress(obj: dict) -> Reading:
    spec, status = obj.get("spec") or {}, _status(obj)
    if (spec.get("updateStrategy") or {}).get("type", "RollingUpdate") != "RollingUpdate":
        raise ReadError("an OnDelete DaemonSet has no rollout to wait on")
    want = status.get("desiredNumberScheduled", 0)
    updated = status.get("updatedNumberScheduled", 0)
    available = status.get("numberAvailable", 0)
    if updated < want:
        return Reading("running", f"{updated} of {want} new pods scheduled")
    if available < want:
        return Reading("running", f"{available} of {want} updated pods available")
    return Reading("rolled-out", f"{want} of {want} pods updated and available")


def _job_progress(obj: dict) -> Reading:
    for kind, state in (("Failed", "failed"), ("Complete", "complete")):
        cond = _condition(obj, kind)
        if cond and cond.get("status") == "True":
            detail = cond.get("message") or cond.get("reason") or kind
            return Reading(state, detail)
    status = _status(obj)
    counts = ", ".join(f"{status.get(k, 0)} {k}" for k in ("active", "succeeded", "failed"))
    return Reading("running", counts)


def new_pods(kind: str, obj: dict, items: list[dict]) -> list[dict]:
    """The pods of the revision being rolled out, from a list of pods (and ReplicaSets)."""
    pods = [i for i in items if i.get("kind") == "Pod"]
    if kind == "job":
        return pods
    if kind == "deployment":
        revision = _annotation(obj, "deployment.kubernetes.io/revision")
        uid = (obj.get("metadata") or {}).get("uid")
        hashes = {
            _labels(rs).get("pod-template-hash")
            for rs in items
            if rs.get("kind") == "ReplicaSet"
            and _annotation(rs, "deployment.kubernetes.io/revision") == revision
            and any(
                o.get("uid") == uid for o in (rs.get("metadata") or {}).get("ownerReferences") or []
            )
        }
        return [p for p in pods if _labels(p).get("pod-template-hash") in hashes - {None}]
    if kind == "statefulset":
        revision = _status(obj).get("updateRevision")
        return [
            p for p in pods if revision and _labels(p).get("controller-revision-hash") == revision
        ]
    # A DaemonSet's status names no revision; its pods carry the template generation instead.
    generation = _annotation(obj, "deprecated.daemonset.template.generation")
    return [
        p for p in pods if generation and _labels(p).get("pod-template-generation") == generation
    ]


PROGRESS = {
    "deployment": _deployment_progress,
    "statefulset": _statefulset_progress,
    "daemonset": _daemonset_progress,
    "job": _job_progress,
}


@dataclass(frozen=True)
class RolloutWait:
    kind: str
    name: str
    namespace: str | None
    context: str | None
    run: Runner = field(default=subprocess.run, compare=False, repr=False)

    def describe(self) -> Description:
        return Description(
            terminal={"rolled-out": 0, "complete": 0, "failed": 1}, interval_s=INTERVAL_S
        )

    def _kubectl(self, args: list[str]) -> dict:
        cmd = ["kubectl"]
        if self.context:
            cmd += ["--context", self.context]
        if self.namespace:
            cmd += ["--namespace", self.namespace]
        cmd += [*args, "--output", "json"]
        try:
            out = self.run(
                cmd, capture_output=True, text=True, timeout=KUBECTL_TIMEOUT_S, check=False
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ReadError(f"kubectl did not run: {exc}") from exc
        if out.returncode != 0:
            raise ReadError(
                f"kubectl {' '.join(args[:2])} exited {out.returncode}: {out.stderr.strip()[-300:]}"
            )
        try:
            return json.loads(out.stdout)
        except ValueError as exc:
            raise ReadError(f"kubectl {' '.join(args[:2])} printed no JSON") from exc

    def read(self) -> Reading:
        obj = self._kubectl(["get", f"{self.kind}/{self.name}"])
        generation = (obj.get("metadata") or {}).get("generation", 0)
        observed = _status(obj).get("observedGeneration", 0)
        if self.kind != "job" and observed < generation:
            # The status still describes the previous spec, so nothing below can be judged.
            return Reading("running", f"waiting for generation {generation} to be observed")
        progress = PROGRESS[self.kind](obj)
        if progress.state != "running":
            return progress
        selector = ((obj.get("spec") or {}).get("selector") or {}).get("matchLabels") or {}
        if not selector:
            return progress
        kinds = "replicasets,pods" if self.kind == "deployment" else "pods"
        labels = ",".join(f"{k}={v}" for k, v in sorted(selector.items()))
        items = self._kubectl(["get", kinds, "--selector", labels]).get("items") or []
        fatal, notes = pod_problems(new_pods(self.kind, obj, items))
        if fatal:
            return Reading("failed", fatal)
        if notes:
            return Reading("running", f"{progress.detail}; {'; '.join(notes[:3])}")
        return progress


class RolloutSource:
    name = "k8s-rollout"
    summary = (
        "a Deployment, StatefulSet or DaemonSet rolls out, or a Job completes (0); or fails (1)"
    )

    def bind(self, args: list[str]) -> RolloutWait:
        parser = ArgParser(prog="cc-wait k8s-rollout", add_help=False)
        parser.add_argument("target", metavar="KIND/NAME")
        parser.add_argument("-n", "--namespace")
        parser.add_argument("--context")
        ns = parser.parse_args(args)
        kind, _, name = ns.target.partition("/")
        if kind.lower() not in KINDS or not _NAME.match(name):
            parser.error(
                f"{ns.target!r} is not KIND/NAME with KIND one of deployment, statefulset, "
                "daemonset or job"
            )
        return RolloutWait(KINDS[kind.lower()], name, ns.namespace, ns.context)
