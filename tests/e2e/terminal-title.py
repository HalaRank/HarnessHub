"""Opt-in built-CLI PTY title check with isolated data and a Mock ACP Agent."""
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
import uuid

bun, cli = sys.argv[1:3]
mock = os.path.abspath("tests/fixtures/mock-acp/server.mjs")
os.umask(0o077)
root = tempfile.mkdtemp(prefix="hhu-terminal-title-pty-")
os.environ.update({
    "XDG_CONFIG_HOME": root + "/config",
    "XDG_DATA_HOME": root + "/data",
    "XDG_STATE_HOME": root + "/state",
})
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
child = None
output = bytearray()
title_pattern = re.compile(rb"\x1b\][02];(.*?)(?:\x07|\x1b\\)")


def api(path, method="GET", body=None):
    with open(root + "/state/harnesshub/instance.json", encoding="utf8") as source:
        instance = json.load(source)
    request = urllib.request.Request(
        "http://127.0.0.1:" + str(instance["port"]) + path,
        data=None if body is None else json.dumps(body).encode(), method=method,
        headers={"Authorization": "Bearer " + instance["token"], "Content-Type": "application/json"},
    )
    with opener.open(request, timeout=10) as response:
        return json.load(response)


def read_for(seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if select.select([child[1]], [], [], min(0.03, max(0, deadline - time.monotonic())))[0]:
            try:
                data = os.read(child[1], 65536)
            except OSError:
                return
            if not data:
                return
            output.extend(data)


def titles(offset=0):
    return [match.decode("utf8") for match in title_pattern.findall(output[offset:])]


def wait_for(check, label):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        read_for(0.05)
        if check():
            return
    raise AssertionError(label)


def submit(conversation, message):
    return api("/v1/conversations/" + conversation["id"] + "/turns", "POST", {
        "message": message, "requestId": str(uuid.uuid4()), "harnessId": "mock-title",
    })


def cancel(turn):
    api("/v1/turns/" + turn["id"] + "/cancel", "POST")
    wait_for(lambda: api("/v1/turns/" + turn["id"])["endedAt"], "turn did not cancel")


try:
    subprocess.run([bun, cli, "daemon", "start"], check=True, capture_output=True)
    api("/v1/harness-profiles", "POST", {
        "id": "mock-title", "name": "Title Mock", "command": "node", "args": [mock],
    })
    projects = []
    for name in ["selected-idle", "background"]:
        directory = root + "/" + name
        os.mkdir(directory)
        projects.append(api("/v1/projects", "POST", {"rootPath": directory, "name": name}))
    idle = api("/v1/projects/" + projects[0]["id"] + "/conversations", "POST", {"title": "Idle"})
    background = [api("/v1/projects/" + projects[1]["id"] + "/conversations", "POST", {
        "title": "Background " + str(index),
    }) for index in range(2)]
    api("/v1/preferences", "PATCH", {"lastConversationId": idle["id"], "showActivity": False})
    pid, descriptor = pty.fork()
    if pid == 0:
        os.chdir(os.path.expanduser("~"))
        os.environ["TERM"] = "xterm-256color"
        os.execv(bun, [bun, cli])
    child = [pid, descriptor]
    fcntl.ioctl(descriptor, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 160, 0, 0))
    wait_for(lambda: "hhu" in titles() and b"Connected" in output, "idle hhu title missing")
    offset = len(output)
    turns = [submit(conversation, "wait") for conversation in background]
    wait_for(lambda: api("/v1/snapshot")["activity"]["running"] == 2, "parallel turns missing")
    wait_for(lambda: len(set(titles(offset)) - {"hhu"}) >= 2, "background title did not animate")
    cancel(turns[0])
    offset = len(output)
    wait_for(lambda: len(set(titles(offset)) - {"hhu"}) >= 2, "second turn lost its spinner")
    offset = len(output)
    cancel(turns[1])
    wait_for(lambda: "hhu" in titles(offset), "last cancellation did not restore idle title")
    offset = len(output)
    read_for(0.4)
    assert not titles(offset), titles(offset)
    offset = len(output)
    approval = submit(background[0], "permission")
    wait_for(lambda: api("/v1/turns/" + approval["id"])["state"] == "WAITING_APPROVAL",
             "Mock approval missing")
    wait_for(lambda: len(set(titles(offset)) - {"hhu"}) >= 2, "approval title did not animate")
    offset = len(output)
    cancel(approval)
    wait_for(lambda: "hhu" in titles(offset), "approval cancellation did not restore idle title")
    offset = len(output)
    submit(background[1], "wait")
    wait_for(lambda: len(set(titles(offset)) - {"hhu"}) >= 2, "active title missing before disconnect")
    offset = len(output)
    subprocess.run([bun, cli, "daemon", "stop", "--cancel-active"], check=True, capture_output=True)
    wait_for(lambda: b"Disconnected" in output[offset:] and titles()[-1] == "hhu",
             "disconnect did not stop animation")
    os.write(descriptor, b"\x03")
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        read_for(0.05)
        exited, status = os.waitpid(pid, os.WNOHANG)
        if exited:
            assert os.waitstatus_to_exitcode(status) == 0, status
            child[0] = None
            break
    assert child[0] is None, "TUI did not exit"
    print("PASS: idle hhu, background animation, parallel turns, approvals, cancellation, disconnect, clean exit")
    print("Isolated evidence directory:", root)
finally:
    if child is not None:
        if child[0] is not None:
            os.kill(child[0], signal.SIGTERM)
            os.waitpid(child[0], 0)
        os.close(child[1])
    subprocess.run([bun, cli, "daemon", "stop", "--cancel-active"], capture_output=True)
    with open(root + "/terminal-output.bin", "wb") as evidence:
        evidence.write(output)
