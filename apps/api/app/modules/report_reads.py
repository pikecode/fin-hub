"""Reuse calculations only inside an explicit report read, never across requests."""

from collections.abc import Iterator
from contextlib import contextmanager
from copy import deepcopy
from functools import wraps
from inspect import signature

from sqlalchemy import event
from sqlalchemy.orm import Session

_KEY = "finhub_report_read"
_MISSING = object()


def read_cache(session: Session):
    cache = session.info.get(_KEY)
    if session.new or session.dirty or session.deleted:
        if cache is not None:
            cache.clear()
        return None
    return cache


@contextmanager
def report_read_scope(session: Session, *, enabled: bool = True) -> Iterator[None]:
    if not enabled:
        previous = session.info.get(_KEY, _MISSING)
        session.info[_KEY] = None
        try:
            yield
        finally:
            if previous is _MISSING:
                session.info.pop(_KEY, None)
            else:
                session.info[_KEY] = previous
        return
    if _KEY in session.info:
        yield
        return
    cache = {}
    session.info[_KEY] = cache

    def invalidate(*args):
        cache.clear()

    def invalidate_dml(state):
        if state.is_insert or state.is_update or state.is_delete:
            invalidate()

    listeners = [
        ("after_flush", invalidate),
        ("after_commit", invalidate),
        ("after_rollback", invalidate),
        ("do_orm_execute", invalidate_dml),
    ]
    for name, callback in listeners:
        event.listen(session, name, callback)
    try:
        yield
    finally:
        session.info.pop(_KEY, None)
        cache.clear()
        for name, callback in listeners:
            event.remove(session, name, callback)


def memoized_read(namespace: str, *, clone=deepcopy):
    """Functions opt in explicitly; authorization always remains outside the cache."""

    def decorate(function):
        sig = signature(function)

        @wraps(function)
        def wrapped(*args, **kwargs):
            bound = sig.bind(*args, **kwargs)
            bound.apply_defaults()
            session = bound.arguments["session"]
            cache = read_cache(session)
            if cache is None:
                return function(*args, **kwargs)
            key = (namespace, tuple((k, v) for k, v in bound.arguments.items() if k != "session"))
            if key not in cache:
                cache[key] = function(*args, **kwargs)
            return clone(cache[key])

        return wrapped

    return decorate
