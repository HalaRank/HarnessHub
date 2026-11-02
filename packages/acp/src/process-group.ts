import { readdirSync, readFileSync } from "node:fs";

type Member = { pid: number; group: number; session: number; start: string; state: string };
function member(pid: number): Member {
  const value = readFileSync(`/proc/${pid}/stat`, "utf8");
  // comm can contain spaces and parentheses; fields after its last ')' are fixed.
  const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
  return {
    pid,
    state: fields[0] ?? "",
    group: Number(fields[2]),
    session: Number(fields[3]),
    start: fields[19] ?? "",
  };
}
function missing(error: unknown) {
  return ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "");
}

/** Linux detached spawn owns a session/initial process group. Pipe EOF alone
 * says nothing about its descendants. Never signal an observed replacement group. */
export class ProcessGroup {
  private start: string | undefined;
  private gone = false;
  constructor(readonly pid: number) {
    try {
      this.start = member(pid).start;
    } catch {
      // Without an identity sample we cannot safely signal this group.
    }
  }
  private members(): Member[] | undefined {
    if (this.gone) return [];
    try {
      try {
        const leader = member(this.pid);
        if (this.start && leader.start !== this.start) {
          this.gone = true;
          return [];
        }
        if (!this.start) return undefined;
      } catch (error) {
        if (!missing(error)) return undefined;
      }
      const result: Member[] = [];
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          // A descendant can change UID (for example an explicitly allowed native
          // privilege helper). Session ownership, not UID, determines liveness.
          const item = member(Number(entry));
          if (item.session === this.pid && !["Z", "X"].includes(item.state)) result.push(item);
        } catch (error) {
          if (!missing(error)) return undefined;
        }
      }
      if (!result.length) this.gone = true;
      return result;
    } catch {
      return undefined;
    }
  }
  empty() {
    return this.members()?.length === 0;
  }
  signal(signal: NodeJS.Signals) {
    const members = this.members();
    if (!this.start || !members?.length) return;
    for (const group of new Set(members.map((item) => item.group))) {
      // Revalidate session membership immediately before signalling, including
      // descendants that made their own process group in the owned session.
      const current = this.members();
      if (!current?.some((item) => item.group === group)) continue;
      try {
        process.kill(-group, signal);
      } catch {
        // Exit races are expected. Polling, never signal delivery, proves completion.
      }
    }
  }
}
