"""Actual hhu PTYs from Home; no renderer mocks or automatic approval decisions."""
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

bun, cli, setup_file = sys.argv[1:4]
setup = json.load(open(setup_file, encoding="utf8"))
children = []


def api(path, method="GET", body=None):
    with open(os.path.join(os.environ["XDG_STATE_HOME"], "harnesshub/instance.json")) as f:
        instance = json.load(f)
    req = urllib.request.Request("http://127.0.0.1:" + str(instance["port"]) + path,
                                 data=None if body is None else json.dumps(body).encode(), method=method,
                                 headers={"Authorization": "Bearer " + instance["token"], "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.load(response)


def launch(conversation_id):
    api("/v1/preferences", "PATCH", {"lastConversationId": conversation_id, "showActivity": True})
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(os.path.expanduser("~"))
        os.environ["TERM"] = "xterm-256color"
        launcher = os.environ.get("HARNESSHUB_PTY_LAUNCHER")
        if launcher:
            os.execv(launcher, [launcher])
        os.execv(bun, [bun, cli])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 48, 180, 0, 0))
    child = [pid, fd, False]
    children.append(child)
    return child


def read_until(child, needle, timeout=20):
    output = b""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if select.select([child[1]], [], [], 0.05)[0]:
            try:
                data = os.read(child[1], 65536)
            except OSError:
                break
            if not data:
                break
            output += data
            visible = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", output)
            if needle.replace(b" ", b"") in visible.replace(b" ", b""):
                return
    with open(setup_file + ".pty-failure", "wb") as evidence:
        os.chmod(setup_file + ".pty-failure", 0o600)
        evidence.write(output)
    raise AssertionError("hhu PTY did not display " + needle.decode())


def quit_child(child):
    os.write(child[1], b"\x03")
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        pid, status = os.waitpid(child[0], os.WNOHANG)
        if pid:
            child[2] = True
            assert os.waitstatus_to_exitcode(status) == 0, status
            return
        if select.select([child[1]], [], [], 0.05)[0]:
            try:
                os.read(child[1], 65536)
            except OSError:
                pass
    raise AssertionError("hhu did not exit cleanly after empty-input Ctrl+C")


def all_events(conversation_id):
    events = []
    cursor = 0
    while True:
        page = api("/v1/conversations/" + conversation_id + "/events?after_seq=" + str(cursor) + "&limit=1000")
        events.extend(page["events"])
        cursor = events[-1]["seq"] if events else 0
        if cursor == page["cursor"]:
            return events


def wait_turn(conversation_id):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        messages = [e for e in all_events(conversation_id) if e["kind"] == "user.message"]
        if messages:
            return api("/v1/turns/" + messages[-1]["turnId"])
        time.sleep(0.05)
    raise AssertionError("TUI did not submit a Prompt")


try:
    original_pid = api("/v1/health")["pid"]
    turns = []
    sessions = []
    for item in setup["conversations"]:
        cid = item["conversationId"]
        child = launch(cid)
        read_until(child, b"m Message")
        os.write(child[1], b"m")
        read_until(child, b"Enter send")
        lines = item["message"].split("\n")
        os.write(child[1], lines[0].encode())
        os.write(child[1], b"\x1b[13;2u")  # Kitty Shift+Enter bytes, not a physical Windows terminal test.
        os.write(child[1], lines[1].encode())
        os.write(child[1], b"\n")  # Ctrl+J fallback in a Linux PTY.
        os.write(child[1], lines[2].encode())
        time.sleep(0.4)
        assert not [e for e in all_events(cid) if e["kind"] == "user.message"], "Newline submitted a Prompt"
        assert api("/v1/conversations/" + cid + "/draft")["text"] == item["message"], "Multiline key decoding changed draft"
        time.sleep(0.1)
        os.write(child[1], b"\r")
        turn = wait_turn(cid)
        turns.append(turn)
        read_until(child, b"RUNNING")
        sessions.append(api("/v1/conversations/" + cid + "/sessions")[-1])
    assert all(api("/v1/turns/" + t["id"])["endedAt"] is None for t in turns), "Turns did not overlap"
    # Switch the first live TUI to the other concurrently running Conversation via its command palette.
    api("/v1/preferences", "PATCH", {"lastConversationId": setup["conversations"][0]["conversationId"]})
    os.write(children[0][1], b"\x10")
    read_until(children[0], b"Command palette")
    os.write(children[0][1], ("Conversation · Phase 4 " + setup["conversations"][1]["harnessId"]).encode())
    time.sleep(0.2)
    os.write(children[0][1], b"\r")
    # Native terminal updates may repaint only "grok" inside an existing ACP header.
    # Check the persisted selection changed as a result of the actual palette action.
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if api("/v1/preferences")["lastConversationId"] == setup["conversations"][1]["conversationId"]:
            break
        if select.select([children[0][1]], [], [], 0.05)[0]:
            os.read(children[0][1], 65536)
    else:
        raise AssertionError("Real command palette did not switch Conversation")
    os.write(children[0][1], b"\x02")  # Hide sidebar.
    fcntl.ioctl(children[0][1], termios.TIOCSWINSZ, struct.pack("HHHH", 30, 75, 0, 0))
    os.kill(children[0][0], signal.SIGWINCH)
    time.sleep(0.15)
    for child in children[:2]:
        quit_child(child)
    assert api("/v1/health")["pid"] == original_pid
    assert any(api("/v1/turns/" + t["id"])["endedAt"] is None for t in turns), "No Agent still running after both TUIs exit"
    reopened = launch(setup["conversations"][0]["conversationId"])
    read_until(reopened, b"m Message")
    for item, session in zip(setup["conversations"], sessions):
        assert api("/v1/conversations/" + item["conversationId"] + "/sessions")[-1]["id"] == session["id"]
    quit_child(reopened)
    # Continue collecting through SQLite with every TUI closed. Never choose native options here.
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        states = [api("/v1/turns/" + t["id"]) for t in turns]
        for item in setup["conversations"]:
            pending = api("/v1/conversations/" + item["conversationId"] + "/approvals")
            if pending:
                print(json.dumps({"requiresUserDecision": True, "conversationId": item["conversationId"], "approvals": pending}), flush=True)
                raise AssertionError("Native approval is waiting for a user; no automatic decision was made")
        if all(t["endedAt"] is not None for t in states):
            break
        time.sleep(0.2)
    assert all(t["state"] == "COMPLETED" for t in states), [(t["id"], t["state"]) for t in states]
    results = []
    for item, session, turn in zip(setup["conversations"], sessions, states):
        events = all_events(item["conversationId"])
        assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
        assert sum(e["origin"] == "client" and isinstance(e["raw"], dict) and e["raw"].get("method") == "session/prompt" for e in events) == 1
        observable = "".join(e["payload"].get("content", {}).get("text", "") for e in events
                             if e["origin"] == "agent" and e["kind"] == "agent_message_chunk")
        observable += json.dumps([e["payload"] for e in events if e["origin"] == "agent" and e["kind"] in
                                  ["tool_call", "tool_call_update"]], ensure_ascii=False)
        assert item["workspace"] in observable, "Native output did not report bound workspace"
        assert item["sentinel"] in observable, "Native output did not read workspace sentinel"
        assert "pass" in observable.lower(), "Native output did not report test result"
        results.append({"conversationId": item["conversationId"], "harnessId": item["harnessId"],
                        "cwd": session["cwd"], "nativeSessionId": session["id"], "turnId": turn["id"],
                        "state": turn["state"], "eventCount": len(events), "promptCount": 1,
                        "nativeCwdAndSentinelObserved": True})
    print(json.dumps({"linuxPtyKittyShiftEnter": True, "ctrlJFallback": True, "liveConversationSwitch": True, "resizeAndSidebar": True, "ptyClients": 3, "cwd": os.path.expanduser("~"), "twoConcurrentTurns": True,
                      "allTuisClosedDuringExecution": True, "sameWorkerAfterReopen": True,
                      "daemonPid": original_pid, "results": results}), flush=True)
finally:
    for pid, fd, done in children:
        if not done:
            try:
                os.kill(pid, signal.SIGTERM)
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if os.waitpid(pid, os.WNOHANG)[0]:
                        break
                    if select.select([fd], [], [], 0.05)[0]:
                        try:
                            os.read(fd, 65536)
                        except OSError:
                            pass
                else:
                    raise AssertionError("Test TUI did not stop safely after SIGTERM")
            except ProcessLookupError:
                pass
        os.close(fd)
