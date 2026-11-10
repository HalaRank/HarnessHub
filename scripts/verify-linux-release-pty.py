"""Smoke the installed hhu entry in a real PTY, using only its release runtime."""
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], [sys.argv[1]])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
done = False
try:
    output = b""
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if select.select([fd], [], [], 0.1)[0]:
            output += os.read(fd, 65536)
            visible = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", output)
            if b"Releaseworkspace" in visible.replace(b" ", b""):
                break
    else:
        raise AssertionError("Installed TUI did not render project: " + repr(output[-3000:]))
    os.write(fd, b"\x03")
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        exited, status = os.waitpid(pid, os.WNOHANG)
        if exited:
            done = True
            assert os.waitstatus_to_exitcode(status) == 0, status
            break
        if select.select([fd], [], [], 0.05)[0]:
            try:
                os.read(fd, 65536)
            except OSError:
                pass
    assert done, "Installed TUI did not exit"
finally:
    if not done:
        os.kill(pid, signal.SIGTERM)
        os.waitpid(pid, 0)
    os.close(fd)
