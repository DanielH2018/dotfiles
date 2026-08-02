#!/usr/bin/env python3
"""Run every tq test module in this directory.

One entry point because tests/tq-digest.test.js checks the number of tests
unittest ran against the number of `def test_` declared across these files: a
class that stops being collected has to show up as a shortfall, and that only
works if one command runs all of them.
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))

if __name__ == "__main__":
    suite = unittest.TestLoader().discover(HERE, pattern="test_*.py")
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
