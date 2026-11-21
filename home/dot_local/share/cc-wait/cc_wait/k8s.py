"""The Kubernetes sources: `k8s-rollout` and `k8s-field`.

`k8s-field` comes after `k8s-rollout`, with its own description at `FieldSource`.

THE `k8s-rollout` SOURCE: a workload finishes rolling out, or a Job finishes.

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

from cc_wait.source import ArgParser, Description, ParsedSource, ReadError, Reading

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
_RESOURCE = re.compile(r"^[a-zA-Z][a-zA-Z0-9.-]*$")

Runner = Callable[..., subprocess.CompletedProcess]


class NotFound(ReadError):
    """The API server answered that the object does not exist."""


def kubectl(run: Runner, context: str | None, namespace: str | None, args: list[str]) -> str:
    """The stdout of one `kubectl` call, or ReadError naming why it failed.

    NotFound is the one failure the API server states as a fact about the object, so it
    alone raises the NotFound subclass. Forbidden, an unknown resource type or an unreachable
    server is a failed read.
    """
    cmd = ["kubectl"]
    if context:
        cmd += ["--context", context]
    if namespace:
        cmd += ["--namespace", namespace]
    cmd += args
    try:
        out = run(cmd, capture_output=True, text=True, timeout=KUBECTL_TIMEOUT_S, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ReadError(f"kubectl did not run: {exc}") from exc
    if out.returncode != 0:
        stderr = out.stderr.strip()
        error = NotFound if "(NotFound)" in stderr else ReadError
        raise error(f"kubectl {' '.join(args[:2])} exited {out.returncode}: {stderr[-300:]}")
    return out.stdout


@dataclass(frozen=True)
class Condition:
    type: str | None
    status: str | None
    reason: str | None
    message: str | None


@dataclass(frozen=True)
class Container:
    name: str
    restarts: int
    waiting_reason: str | None
    waiting_message: str


@dataclass(frozen=True)
class KubeObject:
    """The fields the wait sources read from one kubectl object, with absent ones defaulted.

    A Deployment, StatefulSet, DaemonSet, Job, ReplicaSet or Pod all parse to this shape. A
    field that the kind does not carry keeps its default and is never read for that kind.
    """

    api_kind: str | None
    name: str
    uid: str | None
    generation: int
    labels: dict[str, str]
    annotations: dict[str, str]
    owner_uids: tuple[str | None, ...]
    selector: dict[str, str]
    conditions: tuple[Condition, ...]
    containers: tuple[Container, ...]
    observed_generation: int
    want_replicas: int
    update_type: str
    partition: int
    # Deployment and StatefulSet status
    replicas: int
    updated_replicas: int
    available_replicas: int
    ready_replicas: int
    update_revision: str | None
    current_revision: str | None
    # DaemonSet status
    desired_scheduled: int
    updated_scheduled: int
    available_scheduled: int
    # Job status
    active: int
    succeeded: int
    failed: int

    def condition(self, type_: str) -> Condition | None:
        return next((c for c in self.conditions if c.type == type_), None)


def _section(parent: dict, key: str) -> dict:
    return parent.get(key) or {}


def _container(raw: dict) -> Container:
    waiting = _section(_section(raw, "state"), "waiting")
    return Container(
        name=raw.get("name", "?"),
        restarts=raw.get("restartCount", 0),
        waiting_reason=waiting.get("reason"),
        waiting_message=(waiting.get("message") or "").strip(),
    )


def parse_object(obj: dict) -> KubeObject:
    """The typed fields of one kubectl JSON object, read once so no caller re-checks its shape."""
    meta, spec, status = _section(obj, "metadata"), _section(obj, "spec"), _section(obj, "status")
    strategy = _section(spec, "updateStrategy")
    return KubeObject(
        api_kind=obj.get("kind"),
        name=meta.get("name", "?"),
        uid=meta.get("uid"),
        generation=meta.get("generation", 0),
        labels=_section(meta, "labels"),
        annotations=_section(meta, "annotations"),
        owner_uids=tuple(o.get("uid") for o in meta.get("ownerReferences") or []),
        selector=_section(_section(spec, "selector"), "matchLabels"),
        conditions=tuple(
            Condition(c.get("type"), c.get("status"), c.get("reason"), c.get("message"))
            for c in status.get("conditions") or []
        ),
        containers=tuple(
            _container(cs)
            for cs in (status.get("initContainerStatuses") or [])
            + (status.get("containerStatuses") or [])
        ),
        observed_generation=status.get("observedGeneration", 0),
        want_replicas=spec.get("replicas", 1),
        update_type=strategy.get("type", "RollingUpdate"),
        partition=_section(strategy, "rollingUpdate").get("partition") or 0,
        replicas=status.get("replicas", 0),
        updated_replicas=status.get("updatedReplicas", 0),
        available_replicas=status.get("availableReplicas", 0),
        ready_replicas=status.get("readyReplicas", 0),
        update_revision=status.get("updateRevision"),
        current_revision=status.get("currentRevision"),
        desired_scheduled=status.get("desiredNumberScheduled", 0),
        updated_scheduled=status.get("updatedNumberScheduled", 0),
        available_scheduled=status.get("numberAvailable", 0),
        active=status.get("active", 0),
        succeeded=status.get("succeeded", 0),
        failed=status.get("failed", 0),
    )


def pod_problems(pods: list[KubeObject]) -> tuple[str | None, list[str]]:
    """The first fatal container problem among `pods`, and every other non-routine one."""
    notes: list[str] = []
    for pod in pods:
        for cs in pod.containers:
            reason = cs.waiting_reason
            if not reason or reason in ROUTINE_REASONS:
                continue
            line = f"{pod.name}/{cs.name}: {reason}"
            if reason == "CrashLoopBackOff":
                line += f" after {cs.restarts} restarts"
            fatal = reason in FATAL_REASONS or (
                reason == "CrashLoopBackOff" and cs.restarts >= CRASH_LOOP_RESTARTS
            )
            if fatal:
                message = cs.waiting_message
                return f"{line}: {message}"[:400] if message else line, notes
            notes.append(line)
    return None, notes


def _deployment_progress(obj: KubeObject) -> Reading:
    progressing = obj.condition("Progressing")
    if progressing and progressing.reason == "ProgressDeadlineExceeded":
        return Reading("failed", f"progress deadline exceeded: {progressing.message or ''}")
    want, updated = obj.want_replicas, obj.updated_replicas
    total, available = obj.replicas, obj.available_replicas
    if updated < want:
        return Reading("running", f"{updated} of {want} replicas updated")
    if total > updated:
        return Reading("running", f"{total - updated} old replicas pending termination")
    if available < updated:
        return Reading("running", f"{available} of {updated} updated replicas available")
    return Reading("rolled-out", f"{updated} of {want} replicas updated and available")


def _statefulset_progress(obj: KubeObject) -> Reading:
    if obj.update_type != "RollingUpdate":
        raise ReadError("an OnDelete StatefulSet has no rollout to wait on")
    want, ready, updated = obj.want_replicas, obj.ready_replicas, obj.updated_replicas
    if ready < want:
        return Reading("running", f"{ready} of {want} pods ready")
    if obj.partition:
        if updated < want - obj.partition:
            return Reading(
                "running", f"{updated} of {want - obj.partition} partitioned pods updated"
            )
        return Reading("rolled-out", f"partitioned roll out complete: {updated} pods updated")
    if obj.update_revision != obj.current_revision:
        return Reading("running", f"{updated} of {want} pods at the new revision")
    return Reading("rolled-out", f"{want} of {want} pods ready at the new revision")


def _daemonset_progress(obj: KubeObject) -> Reading:
    if obj.update_type != "RollingUpdate":
        raise ReadError("an OnDelete DaemonSet has no rollout to wait on")
    want, updated, available = obj.desired_scheduled, obj.updated_scheduled, obj.available_scheduled
    if updated < want:
        return Reading("running", f"{updated} of {want} new pods scheduled")
    if available < want:
        return Reading("running", f"{available} of {want} updated pods available")
    return Reading("rolled-out", f"{want} of {want} pods updated and available")


def _job_progress(obj: KubeObject) -> Reading:
    for kind, state in (("Failed", "failed"), ("Complete", "complete")):
        cond = obj.condition(kind)
        if cond and cond.status == "True":
            return Reading(state, cond.message or cond.reason or kind)
    counts = f"{obj.active} active, {obj.succeeded} succeeded, {obj.failed} failed"
    return Reading("running", counts)


def new_pods(kind: str, obj: KubeObject, items: list[KubeObject]) -> list[KubeObject]:
    """The pods of the revision being rolled out, from a list of pods (and ReplicaSets)."""
    pods = [i for i in items if i.api_kind == "Pod"]
    if kind == "job":
        return pods
    if kind == "deployment":
        revision_key = "deployment.kubernetes.io/revision"
        revision = obj.annotations.get(revision_key)
        hashes = {
            rs.labels.get("pod-template-hash")
            for rs in items
            if rs.api_kind == "ReplicaSet"
            and rs.annotations.get(revision_key) == revision
            and obj.uid in rs.owner_uids
        }
        return [p for p in pods if p.labels.get("pod-template-hash") in hashes - {None}]
    if kind == "statefulset":
        revision = obj.update_revision
        return [
            p for p in pods if revision and p.labels.get("controller-revision-hash") == revision
        ]
    # A DaemonSet's status names no revision; its pods carry the template generation instead.
    generation = obj.annotations.get("deprecated.daemonset.template.generation")
    return [p for p in pods if generation and p.labels.get("pod-template-generation") == generation]


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
        out = kubectl(self.run, self.context, self.namespace, [*args, "--output", "json"])
        try:
            return json.loads(out)
        except ValueError as exc:
            raise ReadError(f"kubectl {' '.join(args[:2])} printed no JSON") from exc

    def read(self) -> Reading:
        obj = parse_object(self._kubectl(["get", f"{self.kind}/{self.name}"]))
        if self.kind != "job" and obj.observed_generation < obj.generation:
            # The status still describes the previous spec, so nothing below can be judged.
            return Reading("running", f"waiting for generation {obj.generation} to be observed")
        progress = PROGRESS[self.kind](obj)
        if progress.state != "running":
            return progress
        if not obj.selector:
            return progress
        kinds = "replicasets,pods" if self.kind == "deployment" else "pods"
        labels = ",".join(f"{k}={v}" for k, v in sorted(obj.selector.items()))
        listing = self._kubectl(["get", kinds, "--selector", labels]).get("items") or []
        items = [parse_object(i) for i in listing]
        fatal, notes = pod_problems(new_pods(self.kind, obj, items))
        if fatal:
            return Reading("failed", fatal)
        if notes:
            return Reading("running", f"{progress.detail}; {'; '.join(notes[:3])}")
        return progress


class RolloutSource(ParsedSource):
    name = "k8s-rollout"
    summary = (
        "a Deployment, StatefulSet or DaemonSet rolls out, or a Job completes (0); or fails (1)"
    )

    def parser(self) -> ArgParser:
        parser = ArgParser(prog="cc-wait k8s-rollout", add_help=False)
        parser.add_argument("target", metavar="KIND/NAME")
        parser.add_argument("-n", "--namespace")
        parser.add_argument("--context")
        return parser

    def bind(self, args: list[str]) -> RolloutWait:
        parser = self.parser()
        ns = parser.parse_args(args)
        kind, _, name = ns.target.partition("/")
        if kind.lower() not in KINDS or not _NAME.match(name):
            parser.error(
                f"{ns.target!r} is not KIND/NAME with KIND one of deployment, statefulset, "
                "daemonset or job"
            )
        return RolloutWait(KINDS[kind.lower()], name, ns.namespace, ns.context)


@dataclass(frozen=True)
class FieldWait:
    target: str
    jsonpath: str
    equals: str
    fail: tuple[str, ...]
    namespace: str | None
    context: str | None
    run: Runner = field(default=subprocess.run, compare=False, repr=False)

    def describe(self) -> Description:
        return Description(
            terminal={"matched": 0, "failed": 1, "not-found": 1}, interval_s=INTERVAL_S
        )

    def read(self) -> Reading:
        args = ["get", self.target, "--output", f"jsonpath={self.jsonpath}"]
        try:
            value = kubectl(self.run, self.context, self.namespace, args)
        except NotFound as exc:
            return Reading("not-found", str(exc))
        shown = f"{self.jsonpath} = {value!r}"
        if value == self.equals:
            return Reading("matched", shown)
        if value in self.fail:
            return Reading("failed", shown)
        return Reading("waiting", f"{shown}, want {self.equals!r}")


class FieldSource(ParsedSource):
    """`cc-wait k8s-field <resource>/<name> '<jsonpath>' --equals VALUE [--fail VALUE]...`

    Waits until a field of any resource, a custom resource included, reads VALUE, as
    `kubectl wait --for=jsonpath` does. It reads with one `kubectl get -o jsonpath=`, so it
    needs only get on that resource:

        matched    0   the jsonpath prints exactly VALUE
        failed     1   it prints exactly one of the --fail values
        not-found  1   the API server answers NotFound for the object

    Any other output keeps the wait open, the empty output of a key not yet set included.
    A failed read is retried, Forbidden and an unknown resource type included, and is never
    taken as a match. NotFound ends the wait because the value cannot arrive on an object that
    does not exist, and because `kubectl wait` fails on it the same way.
    """

    name = "k8s-field"
    summary = "a resource's jsonpath field reads --equals (0), a --fail value or NotFound (1)"

    def parser(self) -> ArgParser:
        parser = ArgParser(prog="cc-wait k8s-field", add_help=False)
        parser.add_argument("target", metavar="RESOURCE/NAME")
        parser.add_argument("jsonpath", metavar="JSONPATH", help="e.g. '{.status.state}'")
        parser.add_argument("--equals", required=True, help="success: the field reads this")
        parser.add_argument(
            "--fail", action="append", default=[], help="failure: the field reads this"
        )
        parser.add_argument("-n", "--namespace")
        parser.add_argument("--context")
        return parser

    def bind(self, args: list[str]) -> FieldWait:
        parser = self.parser()
        ns = parser.parse_args(args)
        resource, _, name = ns.target.partition("/")
        if not _RESOURCE.match(resource) or not _NAME.match(name):
            parser.error(
                f"{ns.target!r} is not RESOURCE/NAME, such as volumes.longhorn.io/pvc-1234"
            )
        if not (ns.jsonpath.startswith("{") and ns.jsonpath.endswith("}")):
            parser.error(f"{ns.jsonpath!r} is not a jsonpath template such as '{{.status.state}}'")
        if ns.equals in ns.fail:
            parser.error(f"{ns.equals!r} is both the --equals value and a --fail value")
        return FieldWait(
            ns.target, ns.jsonpath, ns.equals, tuple(ns.fail), ns.namespace, ns.context
        )
