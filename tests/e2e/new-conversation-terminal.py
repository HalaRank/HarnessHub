"""Opt-in built-CLI Linux PTY check, isolated data and no Agent requests.
Usage: python3 tests/e2e/new-conversation-terminal.py /absolute/bun /absolute/dist/cli/hhu.js
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
os.umask(0o077)
root = tempfile.mkdtemp(prefix="hhu-new-conversation-pty-")
os.environ.update({
    "XDG_CONFIG_HOME": root + "/config",
    "XDG_DATA_HOME": root + "/data",
    "XDG_STATE_HOME": root + "/state",
})
workspace = root + "/project"
launch_paths = [root + "/launch-a", root + "/launch-b"]
for directory in [workspace, *launch_paths]:
    os.mkdir(directory)
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


def conversations():
    return api("/v1/snapshot")["conversations"]


def launch(directory, args):
    pid, descriptor = pty.fork()
    if pid == 0:
        os.chdir(directory)
        os.environ["TERM"] = "xterm-256color"
        os.execv(bun, [bun, cli, *args])
    fcntl.ioctl(descriptor, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 160, 0, 0))
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
    os.write(child["fd"], b"\x03")

    def exited():
        pid, status = os.waitpid(child["pid"], os.WNOHANG)
        if not pid:
            return False
        child["done"] = True
        assert os.waitstatus_to_exitcode(status) == 0, status
        return True

    until(child, exited, "TUI did not exit safely")


try:
    project = api("/v1/projects", "POST", {"rootPath": workspace, "name": "Shortcut PTY"})
    api("/v1/projects/" + project["id"] + "/conversations", "POST", {"title": "Existing"})
    first = launch(launch_paths[0], [workspace])
    until(first, lambda: "Workspace · " + workspace in visible(first), "project not selected")
    os.write(first["fd"], b"n")
    until(first, lambda: len(conversations()) == 2, "n did not create project conversation")
    created = conversations()[-1]
    assert created["projectId"] == project["id"] and created["workspacePath"] == workspace
    until(first, lambda: "Enter send" in visible(first), "new conversation not editing")
    os.write(first["fd"], b"nN preserved draft")
    until(first, lambda: api("/v1/conversations/" + created["id"] + "/draft")["text"] == "nN preserved draft", "chat letters were consumed")
    assert len(conversations()) == 2
    os.write(first["fd"], b"\x0e")
    until(first, lambda: len(conversations()) == 3, "Ctrl+N did not create standalone conversation")
    standalone = conversations()[-1]
    assert standalone["projectId"] is None and standalone["workspacePath"] == launch_paths[0]
    until(first, lambda: api("/v1/preferences")["lastConversationId"] == standalone["id"], "standalone not selected")
    os.write(first["fd"], b"\x1b")
    time.sleep(0.15)
    os.write(first["fd"], b"\x1b[B")
    until(first, lambda: api("/v1/preferences")["lastProjectId"] == project["id"] and api("/v1/preferences")["lastConversationId"] is None, "project navigation failed")
    os.write(first["fd"], b"N")
    until(first, lambda: len(conversations()) == 4, "uppercase N did not create project conversation")
    assert conversations()[-1]["projectId"] == project["id"]
    until(first, lambda: api("/v1/preferences")["lastConversationId"] == conversations()[-1]["id"], "new project conversation not selected")
    quit_tui(first)
    second = launch(launch_paths[1], [])
    # PTY frames are incremental: stripping cursor escapes can turn an unchanged
    # letter in "codex" into "codx". Check rendered state and persisted identity.
    until(second, lambda: "not initialized" in visible(second)
          and api("/v1/preferences")["lastConversationId"] == conversations()[-1]["id"],
          "saved selection not restored")
    assert api("/v1/conversations/" + conversations()[-1]["id"])["workspacePath"] == workspace
    os.write(second["fd"], b"\x0e")
    until(second, lambda: len(conversations()) == 5, "second TUI Ctrl+N failed")
    assert conversations()[-1]["projectId"] is None
    assert conversations()[-1]["workspacePath"] == launch_paths[1]
    until(second, lambda: api("/v1/preferences")["lastConversationId"] == conversations()[-1]["id"], "second standalone not selected")
    quit_tui(second)
    assert len(api("/v1/snapshot")["projects"]) == 1
    assert api("/v1/health")["pid"] == instance["pid"]
    for conversation in conversations():
        assert api("/v1/conversations/" + conversation["id"] + "/sessions") == []
    evidence = {"root": root, "linuxPty": True, "projectN": True, "uppercaseN": True, "chatInputPreserved": True, "ctrlNPaths": launch_paths, "implicitProjects": 0, "agentRequests": 0, "daemonSurvives": True}
    with open(root + "/evidence.json", "w", encoding="utf8") as target:
        json.dump(evidence, target, ensure_ascii=False, indent=2)
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
