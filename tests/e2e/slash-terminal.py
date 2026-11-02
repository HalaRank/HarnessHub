"""Opt-in Linux PTY against an isolated Daemon/Mock ACP. No provider Prompts.
Usage: python3 tests/e2e/slash-terminal.py /absolute/bun /absolute/dist/cli/hhu.js
"""
import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time
import urllib.request

bun, cli = sys.argv[1:3]
repo = os.path.dirname(os.path.dirname(os.path.dirname(cli)))
os.umask(0o077)
root = tempfile.mkdtemp(prefix="hhu-slash-pty-")
os.environ.update({"XDG_CONFIG_HOME": root + "/config", "XDG_DATA_HOME": root + "/data", "XDG_STATE_HOME": root + "/state"})
workspace = root + "/project"
os.mkdir(workspace)
subprocess.run([bun, cli, "daemon", "start"], check=True, capture_output=True)
instance = json.load(open(root + "/state/harnesshub/instance.json", encoding="utf8"))
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(path, method="GET", body=None):
    req = urllib.request.Request("http://127.0.0.1:" + str(instance["port"]) + path,
        data=None if body is None else json.dumps(body).encode(), method=method,
        headers={"Authorization": "Bearer " + instance["token"], "Content-Type": "application/json"})
    with opener.open(req, timeout=10) as response:
        return json.load(response)


pid = None
fd = None
finished = False
output = bytearray()


def drain():
    while select.select([fd], [], [], 0.02)[0]:
        try:
            data = os.read(fd, 65536)
        except OSError:
            return
        if not data:
            return
        output.extend(data)


def until(check, label):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        drain()
        if check():
            return
        time.sleep(0.03)
    raise AssertionError(label)


def visible():
    return re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", bytes(output)).decode("utf8", "replace")


try:
    api("/v1/harness-profiles", "POST", {"id": "pty", "name": "PTY Mock", "command": "node", "args": [repo + "/tests/fixtures/mock-acp/server.mjs"], "envOverrides": {"HHU_MOCK_COMMANDS": json.dumps([{"name": "review", "description": "PTY_NATIVE_REVIEW"}])}})
    project = api("/v1/projects", "POST", {"rootPath": workspace, "name": "Slash PTY"})
    conversation = api("/v1/projects/" + project["id"] + "/conversations", "POST", {"title": "Slash PTY"})
    base = "/v1/conversations/" + conversation["id"]
    api(base + "/harness", "PUT", {"harnessId": "pty"})
    native = api(base + "/sessions", "POST", {"harnessId": "pty"})
    api("/v1/preferences", "PATCH", {"lastConversationId": conversation["id"], "shortcuts": {}, "showSidebar": False})
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(os.path.expanduser("~"))
        os.environ["TERM"] = "xterm-256color"
        os.execv(bun, [bun, cli])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 110, 0, 0))
    until(lambda: "Alt+M Message" in visible(), "editor load")
    os.write(fd, b"\x1bm/rev")
    until(lambda: "PTY_NATIVE_REVIEW" in visible(), "native menu missing")
    os.write(fd, b"\r")
    until(lambda: api(base + "/draft")["text"] == "/review", "Enter did not complete")
    assert not [e for e in api(base + "/events?limit=1000")["events"] if e["kind"] == "user.message"], "Completion created a Turn"
    os.write(fd, b"\r")
    until(lambda: len([e for e in api(base + "/events?limit=1000")["events"] if e["kind"] == "user.message"]) == 1, "explicit send missing")
    until(lambda: api(base)["runtimeStatus"] == "IDLE", "Turn unfinished")
    os.write(fd, b"\x1bmmahcxfpnoq\x1b[13;2u")
    os.write(fd, "中文🙂".encode())
    os.write(fd, b"\nlast")
    until(lambda: api(base + "/draft")["text"] == "mahcxfpnoq\n中文🙂\nlast", "UTF8/newline draft changed")
    os.write(fd, b"\x10")  # Ctrl+P; close returns to the same editor.
    until(lambda: "Command palette" in visible(), "palette missing")
    os.write(fd, b"\x1b")
    time.sleep(0.15)
    os.write(fd, b"\x02")  # Ctrl+B preserves draft.
    assert api(base + "/draft")["text"] == "mahcxfpnoq\n中文🙂\nlast"
    os.write(fd, b"\x03")
    until(lambda: api(base + "/draft")["text"] == "", "Ctrl+C did not clear")
    assert os.waitpid(pid, os.WNOHANG)[0] == 0, "nonempty Ctrl+C exited"
    os.write(fd, b"\x03")

    def exited():
        global finished
        result, status = os.waitpid(pid, os.WNOHANG)
        if result:
            finished = True
            assert os.waitstatus_to_exitcode(status) == 0
            return True
        return False

    until(exited, "empty Ctrl+C did not exit")
    assert api("/v1/health")["pid"] == instance["pid"]
    assert api(base + "/sessions")[0]["id"] == native["id"]
    es = api(base + "/events?limit=1000")["events"]
    assert len([e for e in es if e["kind"] == "user.message"]) == 1
    assert len([e for e in es if e["origin"] == "client" and (e["raw"] or {}).get("method") == "session/prompt"]) == 1
    evidence = {"linuxPty": True, "launchCwd": os.path.expanduser("~"), "nativeCwd": native["cwd"], "completionTurns": 0, "explicitTurns": 1, "utf8AndNewlines": True, "paletteSidebarPreserveDraft": True, "ctrlCClearThenExit": True, "daemonAndSessionSurvive": True}
    with open(root + "/evidence.json", "w", encoding="utf8") as target:
        json.dump(evidence, target, ensure_ascii=False, indent=2)
    print(json.dumps({"root": root, **evidence}, ensure_ascii=False))
finally:
    if fd is not None:
        with open(root + "/terminal.bin", "wb") as target:
            target.write(output)
        if not finished:
            os.write(fd, b"\x03")
            time.sleep(0.3)
            os.write(fd, b"\x03")
            try:
                until(exited, "failed probe TUI did not close")
            except (ChildProcessError, AssertionError):
                pass
        os.close(fd)
    subprocess.run([bun, cli, "daemon", "stop"], check=True, capture_output=True)
