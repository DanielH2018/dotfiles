"""The interpreter, and the dispatch tables that are jsonq's grammar.

The tables live in this module with the class on purpose. They hold unbound
methods of _Interp, and _INERT composes the operator tables, so both depend
on definition order — which textual order in one module guarantees and a
load order spread across modules would not."""

import ast
import operator
import re

from _jsonq.errors import JsonqError, _Break, _Continue, _nodes, _unsupported
from _jsonq.functions import _CALLABLE_IDS, _text
from _jsonq.guards import _lshift, _mul, _pow
from _jsonq.lambdas import _Lambda
from _jsonq.limits import MAX_DEPTH, MAX_SEQUENCE


class _Interp:
    """Walks the tree directly. No compile step, no eval step.

    `_EXPR_HANDLERS` and `_STMT_HANDLERS` below this class are the grammar. A
    node type absent from them is refused here — not by a list that says no,
    but because nothing exists that could run it.
    """

    def __init__(self, env):
        self.env = env
        self.depth = 0

    # -- dispatch ----------------------------------------------------------

    def visit(self, node, env):
        handler = _EXPR_HANDLERS.get(type(node))
        if handler is None:
            raise JsonqError(_unsupported(node))
        if self.depth >= MAX_DEPTH:
            raise JsonqError("expression nests too deeply")
        self.depth += 1
        try:
            return handler(self, node, env)
        finally:
            self.depth -= 1

    def execute(self, node, env):
        handler = _STMT_HANDLERS.get(type(node))
        if handler is None:
            raise JsonqError(_unsupported(node))
        handler(self, node, env)

    # -- expressions -------------------------------------------------------

    def _expression(self, node, env):
        return self.visit(node.body, env)

    def _constant(self, node, env):
        return node.value

    def _name(self, node, env):
        try:
            return env[node.id]
        except KeyError:
            raise JsonqError(f"name {node.id!r} is not defined") from None

    def _elements(self, items, env):
        out = []
        for item in items:
            if isinstance(item, ast.Starred):
                out.extend(self.visit(item.value, env))
            else:
                out.append(self.visit(item, env))
        return out

    def _list(self, node, env):
        return self._elements(node.elts, env)

    def _tuple(self, node, env):
        return tuple(self._elements(node.elts, env))

    def _set(self, node, env):
        return set(self._elements(node.elts, env))

    def _dict(self, node, env):
        out = {}
        for key, value in zip(node.keys, node.values):
            if key is None:  # {**other}
                out.update(self.visit(value, env))
            else:
                out[self.visit(key, env)] = self.visit(value, env)
        return out

    def _binop(self, node, env):
        op = _BINOPS.get(type(node.op))
        if op is None:
            raise JsonqError(_unsupported(node.op))
        return op(self.visit(node.left, env), self.visit(node.right, env))

    def _unaryop(self, node, env):
        op = _UNARYOPS.get(type(node.op))
        if op is None:
            raise JsonqError(_unsupported(node.op))
        return op(self.visit(node.operand, env))

    def _boolop(self, node, env):
        # `and` returns the first falsey operand, `or` the first truthy one.
        wanted = isinstance(node.op, ast.Or)
        result = wanted
        for value in node.values:
            result = self.visit(value, env)
            if bool(result) is wanted:
                return result
        return result

    def _compare(self, node, env):
        left = self.visit(node.left, env)
        for op_node, right_node in zip(node.ops, node.comparators):
            op = _CMPOPS.get(type(op_node))
            if op is None:
                raise JsonqError(_unsupported(op_node))
            right = self.visit(right_node, env)
            if not op(left, right):
                return False
            left = right
        return True

    def _ifexp(self, node, env):
        chosen = node.body if self.visit(node.test, env) else node.orelse
        return self.visit(chosen, env)

    def _index(self, node, env):
        if isinstance(node, ast.Slice):
            return slice(
                None if node.lower is None else self.visit(node.lower, env),
                None if node.upper is None else self.visit(node.upper, env),
                None if node.step is None else self.visit(node.step, env),
            )
        return self.visit(node, env)

    def _subscript(self, node, env):
        return self.visit(node.value, env)[self._index(node.slice, env)]

    def _call(self, node, env):
        func = self.visit(node.func, env)
        args = self._elements(node.args, env)
        kwargs = {}
        for kw in node.keywords:
            if kw.arg is None:
                kwargs.update(self.visit(kw.value, env))
            else:
                kwargs[kw.arg] = self.visit(kw.value, env)
        if not isinstance(func, _Lambda) and id(func) not in _CALLABLE_IDS:
            raise JsonqError("only the function table and lambdas are callable")
        return func(*args, **kwargs)

    def _lambda(self, node, env):
        spec = node.args
        if (spec.vararg or spec.kwarg or spec.kwonlyargs
                or getattr(spec, "posonlyargs", None)):
            raise JsonqError("a lambda takes plain positional parameters only")
        defaults = [self.visit(d, env) for d in spec.defaults]
        return _Lambda([p.arg for p in spec.args], defaults, node.body, env, self)

    def _comprehend(self, node, env, emit):
        """Comprehensions get their own scope, so a loop variable does not leak
        into --script's namespace the way a bare `for` does."""
        scope = dict(env)

        def loop(level):
            if level == len(node.generators):
                emit(scope)
                return
            gen = node.generators[level]
            if getattr(gen, "is_async", 0):
                raise JsonqError("async comprehensions are not supported")
            for item in self.visit(gen.iter, scope):
                self._bind(gen.target, item, scope)
                if all(self.visit(cond, scope) for cond in gen.ifs):
                    loop(level + 1)

        loop(0)

    def _listcomp(self, node, env):
        out = []
        self._comprehend(node, env, lambda s: out.append(self.visit(node.elt, s)))
        return out

    def _setcomp(self, node, env):
        return set(self._listcomp(node, env))

    def _genexp(self, node, env):
        """Evaluated eagerly into a list. Nothing in this grammar has side
        effects, so the only observable difference from a real generator is
        that it is not lazy — and laziness would only hide work from the
        wall-clock timeout."""
        return self._listcomp(node, env)

    def _dictcomp(self, node, env):
        out = {}

        def emit(scope):
            out[self.visit(node.key, scope)] = self.visit(node.value, scope)

        self._comprehend(node, env, emit)
        return out

    def _joinedstr(self, node, env):
        return "".join(_text(self.visit(piece, env)) for piece in node.values)

    def _formattedvalue(self, node, env):
        value = self.visit(node.value, env)
        if node.conversion == 114:  # !r
            value = repr(value)
        elif node.conversion == 115:  # !s
            value = _text(value)
        elif node.conversion == 97:  # !a
            value = ascii(value)
        if node.format_spec is None:
            return _text(value)
        spec = self.visit(node.format_spec, env)
        if not isinstance(value, (str, int, float, bool)):
            raise JsonqError("a format spec only applies to a string or a number")
        # A spec's width field is an allocation request: `f"{1:>10000000000}"`
        # asks for a ten-billion-character string, and no cap above sees it
        # because the spec itself is twelve characters long.
        if len(spec) > 64:
            raise JsonqError("format spec is too long")
        if any(int(run) > MAX_SEQUENCE for run in re.findall(r"\d+", spec)):
            raise JsonqError("format spec width is too large")
        # The two-argument builtin over a scalar, not str.format's template
        # language: a format spec cannot name an attribute.
        return format(value, spec)

    # -- statements (--script only) ----------------------------------------

    def _module(self, node, env):
        for stmt in node.body:
            self.execute(stmt, env)

    def _expr_stmt(self, node, env):
        self.visit(node.value, env)

    def _bind(self, target, value, env):
        if isinstance(target, ast.Name):
            env[target.id] = value
        elif isinstance(target, (ast.Tuple, ast.List)):
            items = list(value)
            if len(items) != len(target.elts):
                raise ValueError(
                    f"cannot unpack {len(items)} values into {len(target.elts)}"
                )
            for sub, item in zip(target.elts, items):
                self._bind(sub, item, env)
        elif isinstance(target, ast.Subscript):
            container = self.visit(target.value, env)
            container[self._index(target.slice, env)] = value
        else:
            raise JsonqError(_unsupported(target))

    def _assign(self, node, env):
        value = self.visit(node.value, env)
        for target in node.targets:
            self._bind(target, value, env)

    def _augassign(self, node, env):
        op = _BINOPS.get(type(node.op))
        if op is None:
            raise JsonqError(_unsupported(node.op))
        current = self.visit(node.target, env)
        self._bind(node.target, op(current, self.visit(node.value, env)), env)

    def _if(self, node, env):
        body = node.body if self.visit(node.test, env) else node.orelse
        for stmt in body:
            self.execute(stmt, env)

    def _for(self, node, env):
        for item in self.visit(node.iter, env):
            self._bind(node.target, item, env)
            try:
                for stmt in node.body:
                    self.execute(stmt, env)
            except _Break:
                break
            except _Continue:
                continue
        else:
            for stmt in node.orelse:
                self.execute(stmt, env)

    def _while(self, node, env):
        while self.visit(node.test, env):
            try:
                for stmt in node.body:
                    self.execute(stmt, env)
            except _Break:
                break
            except _Continue:
                continue
        else:
            for stmt in node.orelse:
                self.execute(stmt, env)

    def _break(self, node, env):
        raise _Break()

    def _continue(self, node, env):
        raise _Continue()

    def _pass(self, node, env):
        return None


_EXPR_HANDLERS = {
    ast.Expression: _Interp._expression,
    ast.Constant: _Interp._constant,
    ast.Name: _Interp._name,
    ast.List: _Interp._list,
    ast.Tuple: _Interp._tuple,
    ast.Set: _Interp._set,
    ast.Dict: _Interp._dict,
    ast.BinOp: _Interp._binop,
    ast.UnaryOp: _Interp._unaryop,
    ast.BoolOp: _Interp._boolop,
    ast.Compare: _Interp._compare,
    ast.IfExp: _Interp._ifexp,
    ast.Subscript: _Interp._subscript,
    ast.Call: _Interp._call,
    ast.Lambda: _Interp._lambda,
    ast.ListComp: _Interp._listcomp,
    ast.SetComp: _Interp._setcomp,
    ast.DictComp: _Interp._dictcomp,
    ast.GeneratorExp: _Interp._genexp,
    ast.JoinedStr: _Interp._joinedstr,
    ast.FormattedValue: _Interp._formattedvalue,
}

_STMT_HANDLERS = {
    ast.Module: _Interp._module,
    ast.Expr: _Interp._expr_stmt,
    ast.Assign: _Interp._assign,
    ast.AugAssign: _Interp._augassign,
    ast.If: _Interp._if,
    ast.For: _Interp._for,
    ast.While: _Interp._while,
    ast.Break: _Interp._break,
    ast.Continue: _Interp._continue,
    ast.Pass: _Interp._pass,
}

_BINOPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: _mul,
    ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod, ast.Pow: _pow, ast.LShift: _lshift,
    ast.RShift: operator.rshift, ast.BitOr: operator.or_,
    ast.BitXor: operator.xor, ast.BitAnd: operator.and_,
}

_UNARYOPS = {
    ast.Not: operator.not_, ast.USub: operator.neg,
    ast.UAdd: operator.pos, ast.Invert: operator.invert,
}

_CMPOPS = {
    ast.Eq: operator.eq, ast.NotEq: operator.ne,
    ast.Lt: operator.lt, ast.LtE: operator.le,
    ast.Gt: operator.gt, ast.GtE: operator.ge,
    ast.Is: operator.is_, ast.IsNot: operator.is_not,
    ast.In: lambda a, b: a in b, ast.NotIn: lambda a, b: a not in b,
}

# Structural nodes that carry no behaviour of their own: they are consumed by
# the handlers above rather than dispatched. Listed so _validate can recognise
# a well-formed tree; none of them can run anything on its own.
_INERT = (
    _nodes("Load", "Store", "comprehension", "arguments", "arg", "keyword",
           "Slice", "Starred", "And", "Or")
    | set(_BINOPS) | set(_UNARYOPS) | set(_CMPOPS)
)
