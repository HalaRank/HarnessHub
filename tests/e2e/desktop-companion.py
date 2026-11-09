"""Read-only real hhu PTY companion for the isolated Windows Desktop smoke test."""
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

bun, cli, output = sys.argv[1:4]
start = os.path.join(output, "start-tui")
stop = os.path.join(output, "stop-tui")
deadline = time.monotonic() + 600
while not os.path.exists(start) and time.monotonic() < deadline:
    if os.path.exists(stop):
        sys.exit(0)
    time.sleep(0.1)
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.chdir(os.path.expanduser("~"))
    os.execv(bun, [bun, cli])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 160, 0, 0))
seen = b""
exited = False
try:
    while time.monotonic() < deadline and not os.path.exists(stop):
        if select.select([fd], [], [], 0.1)[0]:
            try:
                seen = (seen + os.read(fd, 65536))[-300000:]
            except OSError:
                break
        if b"HarnessHub" in seen:
            with open(os.path.join(output, "tui-ready"), "w") as f:
                f.write("ready")
        if os.waitpid(pid, os.WNOHANG)[0]:
            exited = True
            break
finally:
    # Only close this read-only TUI; Daemon/ACP are owned by the test's normal cleanup.
    if not exited:
        for _ in range(3):
            os.write(fd, b"\x03")
            time.sleep(0.2)
        end = time.monotonic() + 4
        while time.monotonic() < end:
            if os.waitpid(pid, os.WNOHANG)[0]:
                exited = True
                break
            if select.select([fd], [], [], 0.05)[0]:
                try:
                    seen = (seen + os.read(fd, 65536))[-300000:]
                except OSError:
                    pass
        if not exited:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
            exited = True
    os.close(fd)
    with open(os.path.join(output, "tui-evidence.json"), "w") as f:
        json.dump({"actualPty": True, "harnessHubRendered": b"HarnessHub" in seen,
                   "sawStreamingReply": b"native-34" in seen,
                   "closedOwnTui": exited, "sentPrompts": 0}, f, indent=2)
