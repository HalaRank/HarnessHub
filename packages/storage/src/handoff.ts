import { randomUUID } from "node:crypto";
import { AppError, type HandoffStatus } from "@harnesshub/shared";
import { and, eq, notInArray } from "drizzle-orm";
import type { Store } from "./index";
import { conversations, handoffs, managedWorktrees } from "./schema";

const transitions: Record<HandoffStatus, HandoffStatus[]> = {
  PENDING: ["GENERATING", "FAILED", "CANCELLED"],
  GENERATING: ["READY", "FAILED", "UNCERTAIN", "CANCELLED"],
  READY: ["DELIVERING", "FAILED", "CANCELLED"],
  DELIVERING: ["COMMITTED", "UNCERTAIN"],
  FAILED: ["GENERATING", "READY", "CANCELLED"],
  UNCERTAIN: [],
  COMMITTED: [],
  CANCELLED: [],
};
export class HandoffStore {
  constructor(readonly store: Store) {}
  list(conversationId: string) {
    return this.store.db
      .select()
      .from(handoffs)
      .where(eq(handoffs.conversationId, conversationId))
      .orderBy(handoffs.createdAt)
      .all();
  }
  get(id: string) {
    const row = this.store.db.select().from(handoffs).where(eq(handoffs.id, id)).get();
    if (!row) throw new AppError(404, "Handoff not found");
    return row;
  }
  open(conversationId: string) {
    return this.store.db
      .select()
      .from(handoffs)
      .where(
        and(
          eq(handoffs.conversationId, conversationId),
          notInArray(handoffs.status, ["COMMITTED", "CANCELLED"]),
        ),
      )
      .get();
  }
  add(value: Omit<typeof handoffs.$inferInsert, "id" | "createdAt" | "updatedAt">) {
    return this.store.db
      .insert(handoffs)
      .values({ ...value, id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now() })
      .returning()
      .get();
  }
  move(
    id: string,
    from: HandoffStatus,
    to: HandoffStatus,
    patch: Partial<typeof handoffs.$inferInsert> = {},
  ) {
    if (!transitions[from].includes(to))
      throw new AppError(409, `Invalid Handoff transition ${from} → ${to}`);
    const row = this.store.db
      .update(handoffs)
      .set({ ...patch, status: to, updatedAt: Date.now() })
      .where(and(eq(handoffs.id, id), eq(handoffs.status, from)))
      .returning()
      .get();
    if (!row) throw new AppError(409, "Handoff changed in another client");
    return row;
  }
  patch(id: string, patch: Partial<typeof handoffs.$inferInsert>) {
    this.store.db
      .update(handoffs)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(handoffs.id, id))
      .run();
  }
  bind(
    conversationId: string,
    patch: { activeNativeSessionId?: string | null; selectedHarnessId?: string | null },
  ) {
    this.store.db
      .update(conversations)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(conversations.id, conversationId))
      .run();
    return this.store.record("conversation.harness", conversationId);
  }
  worktrees() {
    return this.store.db.select().from(managedWorktrees).all();
  }
  worktree(id: string) {
    const row = this.store.db
      .select()
      .from(managedWorktrees)
      .where(eq(managedWorktrees.id, id))
      .get();
    if (!row) throw new AppError(404, "Managed worktree not found");
    return row;
  }
  addWorktree(value: typeof managedWorktrees.$inferInsert) {
    this.store.db.insert(managedWorktrees).values(value).run();
  }
  updateWorktree(id: string, patch: Partial<typeof managedWorktrees.$inferInsert>) {
    this.store.db
      .update(managedWorktrees)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(managedWorktrees.id, id))
      .run();
  }
}
