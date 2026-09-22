# Runs inside a marimo kernel's scratchpad, prepended to the code each colab
# tool sends. Everything here is scratchpad-local: the names vanish when the
# call returns, which is why it is resent rather than installed.
#
# Output is one JSON document on stdout between two markers, so the tool can
# separate what it asked for from whatever the notebook printed while cells
# reran. Keep it dependency-free: the kernel may have nothing but marimo.
import builtins as _builtins
import json as _json
import sys as _sys
import traceback as _traceback

import marimo._code_mode as _cm

_BUILTINS = frozenset(dir(_builtins))

_MARK_OPEN = "<<colab:json>>"
_MARK_CLOSE = "<</colab:json>>"


def _emit(payload):
    _sys.stdout.write("\n" + _MARK_OPEN + _json.dumps(payload, default=str) + _MARK_CLOSE + "\n")
    _sys.stdout.flush()


def _clip(text, limit):
    if text is None:
        return None
    text = str(text)
    if len(text) <= limit:
        return text
    return text[:limit] + f"… [{len(text) - limit} more characters]"


def _strip_html(html):
    import re
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", html, flags=re.S | re.I)
    text = re.sub(r"<br\s*/?>|</(p|div|tr|li|h[1-6])>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"&lt;", "<", text)
    text = re.sub(r"&gt;", ">", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _output_json(out, limit):
    """A cell output as something a model can read: text, and an image when
    the output is one."""
    if out is None:
        return None
    mimetype = getattr(out, "mimetype", None) or "text/plain"
    data = getattr(out, "data", None)
    if data is None or data == "":
        return None
    entry = {"mimetype": mimetype}
    if mimetype.startswith("image/"):
        payload = data if isinstance(data, str) else str(data)
        if payload.startswith("data:"):
            payload = payload.split(",", 1)[1]
        entry["image"] = payload
        return entry
    if mimetype in ("text/html", "text/markdown"):
        # mo.md renders to html too; the markdown source is not kept
        text = data if isinstance(data, str) else str(data)
        # marimo puts a data-url image inside an <img> for plots
        import re
        m = re.search(r'src="data:(image/[a-z+]+);base64,([^"]+)"', text)
        if m and len(m.group(2)) > 200:
            entry["image"] = m.group(2)
            entry["mimetype"] = m.group(1)
            entry["text"] = _clip(_strip_html(text), 400)
            return entry
        entry["text"] = _clip(_strip_html(text), limit)
        return entry
    if mimetype in ("application/json", "application/vnd.marimo+error"):
        try:
            parsed = data if not isinstance(data, str) else _json.loads(data)
            entry["text"] = _clip(_json.dumps(parsed, default=str), limit)
        except Exception:
            entry["text"] = _clip(data, limit)
        return entry
    entry["text"] = _clip(data if isinstance(data, str) else str(data), limit)
    return entry


def _console_json(outs, limit):
    parts = []
    for o in outs or []:
        channel = str(getattr(o, "channel", "")).split(".")[-1].lower()
        parts.append({"channel": channel, "text": _clip(getattr(o, "data", ""), limit)})
    return parts


def _cell_json(ctx, cell, *, code, output, limit):
    impl = ctx.graph.cells.get(cell.id)
    entry = {
        "id": cell.id,
        "name": cell.name or None,
        "status": str(cell.status) if cell.status else None,
        "lines": cell.code.count("\n") + 1 if cell.code else 0,
        "defs": sorted(impl.defs) if impl else [],
        # builtins are references too, but `range` in every other row says nothing
        "refs": sorted(r for r in impl.refs if r not in _BUILTINS) if impl else [],
        "errors": [{"kind": e.kind, "msg": _clip(e.msg, 2000)} for e in cell.errors],
    }
    if code:
        entry["code"] = cell.code
    else:
        first = cell.code.split("\n", 1)[0] if cell.code else ""
        entry["preview"] = _clip(first, 100)
    if output:
        entry["output"] = _output_json(cell.output, limit)
        entry["console"] = _console_json(cell.console_outputs, limit)
    else:
        entry["has_output"] = cell.output is not None and bool(getattr(cell.output, "data", None))
    return entry


def colab_cells(ids=None, limit=4000):
    ctx = _cm.get_context()
    cells = list(ctx.cells)
    if ids:
        wanted = []
        for target in ids:
            try:
                wanted.append(ctx.cells[target])
            except Exception as exc:
                _emit({"error": f"no cell {target!r}: {exc}", "cells": [c.id for c in cells]})
                return
        cells = wanted
    full = bool(ids)
    payload = {
        "count": len(ctx.cells),
        "cells": [_cell_json(ctx, c, code=full, output=full, limit=limit) for c in cells],
    }
    payload["errored"] = [c.id for c in ctx.cells if c.errors]
    payload["stale"] = [c.id for c in ctx.cells if str(c.status) == "stale"]
    _emit(payload)


def _summary(value, limit=300):
    kind = type(value).__name__
    module = type(value).__module__.split(".")[0]
    entry = {"type": kind if module in ("builtins", "__main__") else f"{module}.{kind}"}
    try:
        shape = getattr(value, "shape", None)
        if shape is not None and not callable(shape):
            entry["shape"] = list(shape) if hasattr(shape, "__iter__") else shape
        columns = getattr(value, "columns", None)
        if columns is not None and not callable(columns):
            try:
                entry["columns"] = [str(c) for c in list(columns)][:60]
            except Exception:
                pass
        dtypes = getattr(value, "dtypes", None)
        if dtypes is not None and not callable(dtypes) and "columns" in entry:
            try:
                items = dtypes.items() if hasattr(dtypes, "items") else zip(entry["columns"], dtypes)
                entry["dtypes"] = {str(k): str(v) for k, v in list(items)[:60]}
            except Exception:
                pass
        if hasattr(value, "__len__") and "shape" not in entry:
            try:
                entry["len"] = len(value)
            except Exception:
                pass
        # a UI element: its current value is what matters
        if module == "marimo" and hasattr(value, "value"):
            entry["value"] = _clip(repr(value.value), limit)
        elif entry["type"] not in ("module", "function", "type"):
            entry["repr"] = _clip(repr(value), limit)
    except Exception as exc:
        entry["repr_error"] = str(exc)
    return entry


def colab_vars(names=None, limit=300):
    ctx = _cm.get_context()
    owners = {}
    for cid, impl in ctx.graph.cells.items():
        for name in impl.defs:
            owners[name] = cid
    g = ctx.globals
    chosen = names or [n for n in owners if not n.startswith("_")]
    out = {}
    missing = []
    for name in chosen:
        if name in g:
            entry = _summary(g[name], limit)
            if name in owners:
                entry["cell"] = owners[name]
            out[name] = entry
        else:
            missing.append(name)
    _emit({"variables": out, "missing": missing})


def colab_errors():
    ctx = _cm.get_context()
    cells = []
    for c in ctx.cells:
        if c.errors:
            cells.append({
                "id": c.id,
                "name": c.name or None,
                "preview": _clip(c.code.split("\n", 1)[0], 100),
                "errors": [{"kind": e.kind, "msg": _clip(e.msg, 2000)} for e in c.errors],
                "console": _console_json(c.console_outputs, 2000),
            })
    _emit({"errored": len(cells), "cells": cells})


async def colab_edit(ops, limit=4000):
    """Apply structural operations in one code-mode context, then report the
    cells touched and every cell that errored afterwards."""
    touched = []
    created = {}
    try:
        async with _cm.get_context() as ctx:
            for op in ops:
                kind = op["op"]
                if kind == "create":
                    where = {}
                    for key in ("after", "before"):
                        if op.get(key) is not None:
                            where[key] = created.get(op[key], op[key])
                    cid = ctx.create_cell(
                        op["code"],
                        hide_code=bool(op.get("hide_code", False)),
                        **({"name": op["name"]} if op.get("name") else {}),
                        **where,
                    )
                    created[op.get("ref") or f"new{len(created) + 1}"] = cid
                    touched.append(cid)
                    if op.get("run", True):
                        ctx.run_cell(cid)
                elif kind == "edit":
                    target = created.get(op["id"], op["id"])
                    ctx.edit_cell(target, code=op["code"])
                    touched.append(target)
                    if op.get("run", True):
                        ctx.run_cell(target)
                elif kind == "delete":
                    ctx.delete_cell(created.get(op["id"], op["id"]))
                elif kind == "move":
                    where = {}
                    for key in ("after", "before"):
                        if op.get(key) is not None:
                            where[key] = created.get(op[key], op[key])
                    ctx.move_cell(created.get(op["id"], op["id"]), **where)
                elif kind == "run":
                    target = created.get(op["id"], op["id"])
                    # `stale` and `all` name groups: what a person's "run all"
                    # or "run stale" button does
                    if target in ("stale", "all"):
                        for cell in ctx.cells:
                            if target == "all" or str(cell.status) == "stale" or cell.errors:
                                ctx.run_cell(cell.id)
                                touched.append(cell.id)
                    else:
                        ctx.run_cell(target)
                        touched.append(target)
                else:
                    raise ValueError(f"unknown op {kind!r}")
    except Exception as exc:
        _emit({
            "applied": False,
            "error": f"{type(exc).__name__}: {exc}",
            "traceback": _clip("".join(_traceback.format_exception(exc)), 3000),
        })
        return
    ctx = _cm.get_context()
    ids = list(ctx.cells.keys())
    seen = []
    for cid in touched:
        if cid in ids and cid not in seen:
            seen.append(cid)
    cells = []
    for cid in seen:
        cells.append(_cell_json(ctx, ctx.cells[cid], code=False, output=True, limit=limit))
    errored = [
        _cell_json(ctx, c, code=False, output=False, limit=limit)
        for c in ctx.cells
        if c.errors and c.id not in seen
    ]
    _emit({"applied": True, "created": created, "touched": cells, "other_errors": errored, "count": len(ids)})


def _coerce_ui(element, value):
    """The value as the element's frontend would send it.

    set_ui_value takes the wire form, which differs by element: a dropdown
    wants a list of option keys, a slider a number, a switch a bool. A model
    tends to send the natural form ("large", "8"), so translate."""
    kind = type(element).__name__
    if isinstance(value, str):
        stripped = value.strip()
        if stripped[:1] in "[{" or stripped in ("true", "false", "null") or _looks_numeric(stripped):
            try:
                value = _json.loads(stripped)
            except Exception:
                pass
    if kind in ("dropdown", "multiselect", "radio"):
        options = getattr(element, "options", None)
        keys = list(options.keys()) if isinstance(options, dict) else list(options or [])
        wanted = value if isinstance(value, list) else [value]
        keyed = []
        for v in wanted:
            if v in keys:
                keyed.append(v)
            elif isinstance(options, dict) and v in options.values():
                keyed.append(next(k for k, ov in options.items() if ov == v))
            else:
                raise ValueError(f"{v!r} is not an option of {kind}; options: {keys}")
        if kind == "radio":
            return keyed[0]
        return keyed
    if kind in ("slider", "number"):
        if isinstance(value, str):
            value = float(value)
        return value
    if kind == "range_slider":
        return [float(v) for v in value]
    if kind in ("switch", "checkbox"):
        if isinstance(value, str):
            return value.lower() in ("1", "true", "yes", "on")
        return bool(value)
    return value


def _looks_numeric(text):
    try:
        float(text)
        return True
    except ValueError:
        return False


async def colab_set_ui(expression, value):
    try:
        async with _cm.get_context() as ctx:
            element = eval(expression, dict(ctx.globals))
            if not hasattr(element, "_update") or not hasattr(element, "value"):
                raise TypeError(f"{expression} is {type(element).__name__}, not a UI element")
            before = repr(getattr(element, "value", None))
            wire = _coerce_ui(element, value)
            ctx.set_ui_value(element, wire)
    except Exception as exc:
        _emit({"applied": False, "error": f"{type(exc).__name__}: {exc}"})
        return
    ctx = _cm.get_context()
    try:
        element = eval(expression, dict(ctx.globals))
        now = repr(getattr(element, "value", None))
    except Exception as exc:
        now = f"unreadable: {exc}"
    _emit({
        "applied": True,
        "value": _clip(now, 300),
        "unchanged": now == before,
        "errored": [c.id for c in ctx.cells if c.errors],
    })


async def colab_packages(add=None, remove=None):
    try:
        async with _cm.get_context() as ctx:
            for name in add or []:
                ctx.packages.add(name)
            for name in remove or []:
                ctx.packages.remove(name)
    except Exception as exc:
        _emit({"applied": False, "error": f"{type(exc).__name__}: {exc}"})
        return
    _emit({"applied": True, "added": add or [], "removed": remove or []})


def colab_graph(cell_id=None):
    ctx = _cm.get_context()
    graph = ctx.graph
    nodes = {}
    for cid, impl in graph.cells.items():
        nodes[cid] = {
            "defs": sorted(impl.defs),
            "refs": sorted(impl.refs),
            "parents": sorted(graph.parents.get(cid, ())) if hasattr(graph, "parents") else [],
            "children": sorted(graph.children.get(cid, ())) if hasattr(graph, "children") else [],
        }
    payload = {"cells": nodes}
    if cell_id is not None:
        cid = ctx.cells[cell_id].id
        payload["focus"] = {
            "id": cid,
            "ancestors": sorted(graph.ancestors(cid)),
            "descendants": sorted(graph.descendants(cid)),
        }
    _emit(payload)
