"""Real Linux PTY Ctrl+C and SIGINT; never substitutes for Windows keyboard/clipboard acceptance."""
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time
import urllib.request

bun, cli, cid = sys.argv[1:4]
with open(os.path.join(os.environ["XDG_STATE_HOME"], "harnesshub/instance.json")) as f:
    instance = json.load(f)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def api(path):
    req = urllib.request.Request("http://127.0.0.1:" + str(instance["port"]) + path,
        headers={"Authorization": "Bearer " + instance["token"]})
    with opener.open(req, timeout=5) as response:
        return json.load(response)

pid, fd = pty.fork()
if pid == 0:
    os.chdir(os.path.expanduser("~"))
    os.environ["TERM"] = "xterm-256color"
    os.execv(bun, [bun, cli])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 140, 0, 0))
finished = False
output = bytearray()

def drain():
    output = b""
    while select.select([fd], [], [], 0.02)[0]:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        output += data
    return output

def until(check, label):
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        output.extend(drain())
        if check():
            return
        time.sleep(0.03)
    raise AssertionError(label)

try:
    def ready():
        return b"m Message" in re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", bytes(output))
    until(ready, "TUI editor did not load")
    os.write(fd, b"mclear by SIGINT")
    draft_path = "/v1/conversations/" + cid + "/draft"
    until(lambda: api(draft_path)["text"] == "clear by SIGINT", "first draft not saved")
    os.kill(pid, signal.SIGINT)
    until(lambda: api(draft_path)["text"] == "", "SIGINT bypassed clear input")
    assert os.waitpid(pid, os.WNOHANG)[0] == 0, "SIGINT exited nonempty editor"
    os.write(fd, b"clear by raw key")
    until(lambda: api(draft_path)["text"] == "clear by raw key", "second draft not saved")
    os.write(fd, b"\x03")
    until(lambda: api(draft_path)["text"] == "", "Ctrl+C did not clear")
    assert os.waitpid(pid, os.WNOHANG)[0] == 0, "Ctrl+C exited nonempty editor"
    os.write(fd, b"\x03")
    def exited():
        global finished
        result, status = os.waitpid(pid, os.WNOHANG)
        if result:
            finished = True
            assert os.waitstatus_to_exitcode(status) == 0, status
            return True
        return False
    until(exited, "Empty editor Ctrl+C did not exit")
    assert api("/v1/health")["pid"] == instance["pid"], "TUI exit stopped daemon"
    print(json.dumps({"realLinuxPty": True, "sigintClears": True, "rawCtrlCClears": True, "secondCtrlCExits": True}), flush=True)
finally:
    if not finished:
        os.write(fd, b"\x1bq")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            drain()
            result, status = os.waitpid(pid, os.WNOHANG)
            if result:
                break
            time.sleep(0.05)
    os.close(fd)
