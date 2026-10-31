"""Run the built CLI in two real Linux PTYs (no mocked renderer)."""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

bun, cli = sys.argv[1:3]
children = []

def launch(extra=None):
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(os.path.expanduser("~"))
        os.environ["TERM"] = "xterm-256color"
        os.execv(bun, [bun, cli] + ([extra] if extra else []))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
    children.append([pid, fd, False])
    return children[-1]

def read_until(child, needle, timeout=12):
    output = b""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready, _, _ = select.select([child[1]], [], [], 0.1)
        if ready:
            try:
                data = os.read(child[1], 65536)
            except OSError:
                break
            if not data:
                break
            output += data
            if needle in output:
                return output
    raise AssertionError("PTY did not display expected content: " + repr(output[-3000:]))

def quit_child(child):
    os.write(child[1], b"q")
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        pid, status = os.waitpid(child[0], os.WNOHANG)
        if pid:
            child[2] = True
            assert os.waitstatus_to_exitcode(status) == 0, status
            return
        select.select([child[1]], [], [], 0.05)
        try:
            if select.select([child[1]], [], [], 0)[0]:
                os.read(child[1], 65536)
        except OSError:
            pass
    raise AssertionError("TUI failed to exit after q")

try:
    first = launch()
    read_until(first, b"Workspace:")
    second = launch()
    read_until(second, b"Workspace:")
    quit_child(first)
    # The remaining TUI still processes input after the first one closes.
    os.write(second[1], b"p")
    read_until(second, b"Existing project")
    os.write(second[1], b"\x1b")
    time.sleep(0.15)
    quit_child(second)
    # A separate invocation verifies the quick-open path without depending on cwd.
    third = launch(os.environ["HARNESSHUB_PTY_PROJECT"])
    read_until(third, b"Workspace:")
    quit_child(third)
    print(json.dumps({"ptyClients": 3, "twoConcurrent": True, "quitExitCode": 0, "cwd": os.path.expanduser("~")}))
finally:
    for pid, fd, done in children:
        if not done:
            try:
                os.kill(pid, signal.SIGTERM)
                os.waitpid(pid, 0)
            except ProcessLookupError:
                pass
        os.close(fd)
