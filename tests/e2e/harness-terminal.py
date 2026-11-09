"""Built-CLI Linux PTY check for Ctrl+H; isolated data, Mock ACP, no Prompts.
Usage: python3 tests/e2e/harness-terminal.py /absolute/bun /absolute/dist/cli/hhu.js
"""
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import urllib.request

bun, cli = sys.argv[1:3]
fixture = os.path.abspath("tests/fixtures/mock-acp/server.mjs")
os.umask(0o077)
root = tempfile.mkdtemp(prefix="hhu-harness-pty-")
os.environ.update({
    "XDG_CONFIG_HOME": root + "/config",
    "XDG_DATA_HOME": root + "/data",
    "XDG_STATE_HOME": root + "/state",
})
subprocess.run([bun, cli, "daemon", "start"], check=True, capture_output=True)
with open(root + "/state/harnesshub/instance.json", encoding="utf8") as source:
    instance = json.load(source)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
children = []


def api(path, method="GET", body=None):
    request = urllib.request.Request(
        "http://127.0.0.1:" + str(instance["port"]) + path,
        data=None if body is None else json.dumps(body).encode(), method=method,
        headers={"Authorization": "Bearer " + instance["token"], "Content-Type": "application/json"},
    )
    with opener.open(request, timeout=10) as response:
        return json.load(response)


def launch():
    pid, descriptor = pty.fork()
    if pid == 0:
        os.chdir(root)
        os.environ["TERM"] = "xterm-256color"
        os.execv(bun, [bun, cli])
    fcntl.ioctl(descriptor, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 80, 0, 0))
    child = {"pid": pid, "fd": descriptor, "output": bytearray(), "done": False}
    children.append(child)
    return child


def drain(child):
    while select.select([child["fd"]], [], [], 0.02)[0]:
        try:
            data = os.read(child["fd"], 65536)
        except OSError:
            return
        if not data:
            return
        child["output"].extend(data)


def visible(child):
    return re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", bytes(child["output"])).decode("utf8", "replace")


def until(child, check, label):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        drain(child)
        if check():
            return
        time.sleep(0.03)
    raise AssertionError(label + "\n" + visible(child)[-4000:])


def quit_tui(child):
    os.write(child["fd"], b"/")
    until(child, lambda: "Command palette" in visible(child), "quit palette missing")
    os.write(child["fd"], b"Quit TUI")
    until(child, lambda: "Quit TUI" in visible(child), "quit command missing")
    os.write(child["fd"], b"\r")

    def exited():
        pid, status = os.waitpid(child["pid"], os.WNOHANG)
        if not pid:
            return False
        child["done"] = True
        assert os.waitstatus_to_exitcode(status) == 0, status
        return True

    until(child, exited, "TUI did not exit safely")


def ready_frame(child):
    until(child, lambda: "Escinterrupt" in visible(child).replace(" ", ""), "composer not ready")
    # Resize requests a full frame; streamed terminal diffs can omit unchanged letters.
    child["output"].clear()
    fcntl.ioctl(child["fd"], termios.TIOCSWINSZ, struct.pack("HHHH", 36, 82, 0, 0))
    os.kill(child["pid"], signal.SIGWINCH)
    until(child, lambda: "mock-model" in visible(child), "ACP model not visible")


try:
    api("/v1/harness-profiles", "POST", {
        "id": "mock", "name": "Mock", "command": "node", "args": [fixture], "envOverrides": {},
    })
    project = api("/v1/projects", "POST", {"rootPath": root})
    conversation = api("/v1/projects/" + project["id"] + "/conversations", "POST", {})
    path = "/v1/conversations/" + conversation["id"]
    api(path + "/harness", "PUT", {"harnessId": "mock"})
    api(path + "/sessions", "POST", {"harnessId": "mock"})
    api("/v1/preferences", "PATCH", {
        "lastConversationId": conversation["id"], "showSidebar": False,
    })
    profiles = api("/v1/harness-profiles")
    index = next(i for i, profile in enumerate(profiles) if profile["id"] == "mock")
    first = launch()
    ready_frame(first)
    assert "mock" in visible(first) and "mock-model" in visible(first)
    os.write(first["fd"], b"\r")
    until(first, lambda: "Shift+Enter" in visible(first), "composer not focused")
    os.write(first["fd"], b"preserved draft!")
    until(first, lambda: api(path + "/draft")["text"] == "preserved draft!", "draft not saved")
    os.write(first["fd"], b"\x7f")
    until(first, lambda: api(path + "/draft")["text"] == "preserved draft", "DEL failed to delete")
    for sequence in [b"\x08", b"\x1b[104;5u"]:
        os.write(first["fd"], sequence)
        index = (index + 1) % len(profiles)
        until(first, lambda: api(path)["selectedHarnessId"] == profiles[index]["id"], "Ctrl+H failed")
        assert api(path + "/draft")["text"] == "preserved draft"
    until(first, lambda: "PENDING_SWITCH" in visible(first), "pending target not visible")
    os.write(first["fd"], b"\x1b")
    time.sleep(0.2)
    quit_tui(first)
    second = launch()
    ready_frame(second)
    until(second, lambda: "PENDING_SWITCH" in visible(second), "pending target not restored")
    assert api(path + "/draft")["text"] == "preserved draft"
    quit_tui(second)
    assert len(api(path + "/sessions")) == 1
    assert api(path + "/handoffs") == []
    events = api(path + "/events?limit=1000")["events"]
    assert not any((event.get("raw") or {}).get("method") == "session/prompt" for event in events)
    assert api("/v1/health")["pid"] == instance["pid"]
    evidence = {
        "root": root, "legacyCtrlH": True, "kittyCtrlH": True, "backspace": True,
        "draftPreserved": True, "modelRestored": True, "prompts": 0, "daemonSurvives": True,
    }
    with open(root + "/evidence.json", "w", encoding="utf8") as target:
        json.dump(evidence, target, indent=2)
    print(json.dumps(evidence))
finally:
    for index, child in enumerate(children):
        if not child["done"]:
            try:
                os.kill(child["pid"], signal.SIGTERM)
                os.waitpid(child["pid"], 0)
            except ProcessLookupError:
                pass
        with open(root + "/terminal-" + str(index) + ".bin", "wb") as target:
            target.write(child["output"])
        os.close(child["fd"])
    subprocess.run([bun, cli, "daemon", "stop"], check=True, capture_output=True)
