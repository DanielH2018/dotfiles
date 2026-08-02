"""A lambda defined by the query. A leaf on purpose: it holds the
interpreter that will run its body as an attribute rather than
importing it, which is what keeps functions and interp acyclic."""

class _Lambda:
    """A lambda defined by the query.

    Callable from Python so it can be handed to `sorted(key=...)` and friends,
    but its body is run by _Interp, never by CPython.
    """

    __slots__ = ("params", "defaults", "body", "env", "interp")

    def __init__(self, params, defaults, body, env, interp):
        self.params = params
        self.defaults = defaults
        self.body = body
        self.env = env
        self.interp = interp

    def __call__(self, *args, **kwargs):
        if kwargs:
            raise TypeError("a jsonq lambda takes positional arguments only")
        missing = len(self.params) - len(args)
        if missing < 0 or missing > len(self.defaults):
            raise TypeError(
                f"lambda takes {len(self.params)} argument(s), got {len(args)}"
            )
        values = list(args)
        if missing:
            values += self.defaults[len(self.defaults) - missing:]
        scope = dict(self.env)
        scope.update(zip(self.params, values))
        return self.interp.visit(self.body, scope)
