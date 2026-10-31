import { randomUUID } from "node:crypto";
import {
  AppError,
  type ConversationEvent,
  type HarnessProfile,
  type RuntimeStatus,
  redact,
} from "@harnesshub/shared";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Store } from "./index";
import {
  approvals,
  conversationEvents,
  conversations,
  harnessProfiles,
  nativeSessions,
  turns,
} from "./schema";

export class RuntimeStore {
  constructor(readonly store: Store) {}
  get db() {
    return this.store.db;
  }
  profiles() {
    return this.db
      .select()
      .from(harnessProfiles)
      .all()
      .map((r) => r.profile);
  }
  saveProfile(profile: HarnessProfile) {
    this.db
      .insert(harnessProfiles)
      .values({ id: profile.id, profile })
      .onConflictDoUpdate({ target: harnessProfiles.id, set: { profile } })
      .run();
  }
  sessions(conversationId: string) {
    return this.db
      .select()
      .from(nativeSessions)
      .where(eq(nativeSessions.conversationId, conversationId))
      .orderBy(nativeSessions.createdAt)
      .all();
  }
  session(id: string) {
    const row = this.db.select().from(nativeSessions).where(eq(nativeSessions.id, id)).get();
    if (!row) throw new AppError(404, "Native session not found");
    return row;
  }
  addSession(conversationId: string, harnessId: string, cwd: string, epoch: string) {
    return this.db
      .insert(nativeSessions)
      .values({
        id: randomUUID(),
        conversationId,
        harnessId,
        cwd,
        epoch,
        workerId: randomUUID(),
        status: "STARTING",
        createdAt: Date.now(),
      })
      .returning()
      .get();
  }
  updateSession(id: string, patch: Partial<typeof nativeSessions.$inferInsert>) {
    this.db
      .update(nativeSessions)
      .set({
        ...patch,
        ...(patch.capabilities === undefined ? {} : { capabilities: redact(patch.capabilities) }),
      })
      .where(eq(nativeSessions.id, id))
      .run();
  }
  turn(id: string) {
    const row = this.db.select().from(turns).where(eq(turns.id, id)).get();
    if (!row) throw new AppError(404, "Turn not found");
    return row;
  }
  byRequest(requestId: string) {
    return this.db.select().from(turns).where(eq(turns.requestId, requestId)).get();
  }
  active(conversationId?: string) {
    return this.db
      .select()
      .from(turns)
      .where(
        and(
          isNull(turns.endedAt),
          conversationId ? eq(turns.conversationId, conversationId) : undefined,
        ),
      )
      .all();
  }
  addTurn(conversationId: string, harnessId: string, requestId: string, requestHash: string) {
    return this.db
      .insert(turns)
      .values({
        id: randomUUID(),
        conversationId,
        harnessId,
        requestId,
        requestHash,
        state: "PREPARING",
        createdAt: Date.now(),
      })
      .returning()
      .get();
  }
  updateTurn(id: string, patch: Partial<typeof turns.$inferInsert>) {
    this.db.update(turns).set(patch).where(eq(turns.id, id)).run();
  }
  status(conversationId: string, runtimeStatus: RuntimeStatus) {
    this.db
      .update(conversations)
      .set({ runtimeStatus, updatedAt: Date.now() })
      .where(eq(conversations.id, conversationId))
      .run();
    return this.store.record("conversation.runtime", conversationId);
  }
  append(event: Omit<ConversationEvent, "id" | "seq" | "createdAt">): ConversationEvent {
    return this.db.transaction(() => {
      const seq = this.cursor(event.conversationId) + 1;
      return this.db
        .insert(conversationEvents)
        .values({
          ...event,
          raw: redact(event.raw),
          payload: redact(event.payload),
          id: randomUUID(),
          seq,
          createdAt: Date.now(),
        })
        .returning()
        .get();
    });
  }
  cursor(conversationId: string) {
    return (
      this.db
        .select({ seq: sql<number>`coalesce(max(seq), 0)` })
        .from(conversationEvents)
        .where(eq(conversationEvents.conversationId, conversationId))
        .get()?.seq ?? 0
    );
  }
  events(conversationId: string, after: number, limit: number) {
    return this.db
      .select()
      .from(conversationEvents)
      .where(
        and(
          eq(conversationEvents.conversationId, conversationId),
          gt(conversationEvents.seq, after),
        ),
      )
      .orderBy(conversationEvents.seq)
      .limit(limit)
      .all();
  }
  pending(conversationId: string) {
    return this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.conversationId, conversationId), eq(approvals.status, "PENDING")))
      .all();
  }
  approval(id: string) {
    const row = this.db.select().from(approvals).where(eq(approvals.id, id)).get();
    if (!row) throw new AppError(404, "Approval not found");
    return row;
  }
  addApproval(
    conversationId: string,
    nativeSessionId: string,
    turnId: string,
    acpRequestId: string,
    request: unknown,
  ) {
    return this.db
      .insert(approvals)
      .values({
        id: randomUUID(),
        conversationId,
        nativeSessionId,
        turnId,
        acpRequestId,
        request: redact(request),
        status: "PENDING",
        createdAt: Date.now(),
      })
      .returning()
      .get();
  }
  decide(id: string, status: string, selectedOptionId: string | null = null) {
    return this.db
      .update(approvals)
      .set({ status, selectedOptionId, endedAt: Date.now() })
      .where(and(eq(approvals.id, id), eq(approvals.status, "PENDING")))
      .returning()
      .get();
  }
  recover() {
    this.db.transaction(() => {
      // Stored worker/session identifiers are history, never proof of a live ACP connection.
      for (const turn of this.active()) {
        this.updateTurn(turn.id, { state: "UNCERTAIN", endedAt: Date.now() });
        this.status(turn.conversationId, "UNCERTAIN");
        const event = this.append({
          conversationId: turn.conversationId,
          nativeSessionId: turn.nativeSessionId,
          turnId: turn.id,
          raw: null,
          kind: "runtime.interrupted",
          payload: { state: "UNCERTAIN", reason: "daemon_restart" },
          origin: "runtime",
        });
        this.updateTurn(turn.id, { finishEventSeq: event.seq });
      }
      this.db
        .update(nativeSessions)
        .set({ status: "INTERRUPTED", endedAt: Date.now() })
        .where(isNull(nativeSessions.endedAt))
        .run();
      this.db
        .update(approvals)
        .set({ status: "EXPIRED", endedAt: Date.now() })
        .where(eq(approvals.status, "PENDING"))
        .run();
    });
  }
}
