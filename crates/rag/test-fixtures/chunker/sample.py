# Python fixture — decorated defs, class, module constant.
import os

MAX_RETRIES = 3


def greet(name: str) -> str:
    return f"hello {name}"


class Greeter:
    def __init__(self, prefix):
        self.prefix = prefix

    def greet(self, name):
        return f"{self.prefix} {name}"


@property
def config(self):
    return self._config
