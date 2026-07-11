from dataclasses import dataclass, field


@dataclass(frozen=True)
class Item:
    """One config-surface entity: a hook, skill, agent, plugin, MCP server, etc."""

    name: str
    purpose: str
    provenance: str  # "chezmoi" | "generated" | "work" | "project" | "unmanaged" | "inline" | "unknown"
    fields: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class Category:
    key: str
    title: str
    items: tuple[Item, ...]
    note: str = ""


@dataclass(frozen=True)
class Layer:
    name: str
    path: str
    present: bool
    fields: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class CascadeNode:
    label: str
    provenance: str
    children: tuple["CascadeNode", ...] = ()
    headings: tuple[tuple[int, str], ...] = ()  # (level, text) for the file's # / ## sections
    line_count: int = 0


@dataclass(frozen=True)
class SetupMap:
    generated_at: str
    source_shas: tuple[tuple[str, str], ...]
    layers: tuple[Layer, ...]
    cascade: tuple[CascadeNode, ...]
    categories: tuple[Category, ...]
    counts: tuple[tuple[str, str], ...] = field(default_factory=tuple)


def _node_to_dict(node: CascadeNode) -> dict:
    return {
        "label": node.label,
        "provenance": node.provenance,
        "headings": [list(h) for h in node.headings],
        "line_count": node.line_count,
        "children": [_node_to_dict(c) for c in node.children],
    }


def semantic_payload(setup_map: SetupMap) -> dict:
    """Everything in the map except the volatile fields (generated-at, source SHAs).

    Used as the input to the content hash that gates HTML rewrites, so a
    same-config regeneration doesn't churn git on timestamp/SHA alone.
    """
    return {
        "layers": [
            {"name": l.name, "path": l.path, "present": l.present, "fields": list(l.fields)}
            for l in setup_map.layers
        ],
        "cascade": [_node_to_dict(n) for n in setup_map.cascade],
        "categories": [
            {
                "key": c.key,
                "title": c.title,
                "note": c.note,
                "items": [
                    {"name": i.name, "purpose": i.purpose, "provenance": i.provenance, "fields": list(i.fields)}
                    for i in c.items
                ],
            }
            for c in setup_map.categories
        ],
        "counts": list(setup_map.counts),
    }
