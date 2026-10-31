import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Activity, ChangeEvent, Draft, Preferences } from "@harnesshub/shared";
import { AppError, activeStates, problemStates } from "@harnesshub/shared";
import { privateDir } from "@harnesshub/shared/paths";
import Database from "better-sqlite3";
import { and, eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export async function openStore(file: string, migrations: string) {
  privateDir(join(file, ".."));
  const existed = existsSync(file);
  const sqlite = new Database(file);
  try {
    chmodSync(file, 0o600);
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as {
      entries: unknown[];
    };
    const expected = journal.entries.length;
    const version = sqlite.pragma("user_version", { simple: true }) as number;
    if (version > expected)
      throw new Error(`Database schema ${version} is newer than supported ${expected}`);
    if (version < expected && existed) {
      const backupPath = `${file}.backup-${Date.now()}-${randomUUID()}`;
      await sqlite.backup(backupPath);
      chmodSync(backupPath, 0o600);
    }
    sqlite.pragma("journal_mode = WAL");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: migrations });
    sqlite.pragma(`user_version = ${expected}`);
    for (const path of [file, `${file}-wal`, `${file}-shm`])
      if (existsSync(path)) chmodSync(path, 0o600);
    return new Store(sqlite, db);
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export class Store {
  constructor(
    readonly sqlite: Database.Database,
    readonly db: ReturnType<typeof drizzle<typeof schema>>,
  ) {}
  close() {
    this.sqlite.close();
  }
  listProjects() {
    return this.db.select().from(schema.projects).all();
  }
  getProject(id: string) {
    const project = this.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    if (!project) throw new AppError(404, "Project not found");
    return project;
  }
  projectByRoot(root: string) {
    return this.db.select().from(schema.projects).where(eq(schema.projects.rootPath, root)).get();
  }
  addProject(rootPath: string, name: string) {
    const existing = this.projectByRoot(rootPath);
    if (existing) return { value: existing, event: null };
    const now = Date.now();
    const value = { id: randomUUID(), name, rootPath, createdAt: now, updatedAt: now };
    return this.db.transaction(() => {
      this.db.insert(schema.projects).values(value).run();
      return { value, event: this.record("project.created", value.id) };
    });
  }
  assertWorkspaceMutable(conversationIds: string[]) {
    for (const id of conversationIds) {
      const live = this.db
        .select()
        .from(schema.nativeSessions)
        .where(and(eq(schema.nativeSessions.conversationId, id), sql`ended_at is null`))
        .get();
      const active = this.db
        .select()
        .from(schema.turns)
        .where(and(eq(schema.turns.conversationId, id), sql`ended_at is null`))
        .get();
      if (live || active)
        throw new AppError(
          409,
          "Conversation has a live Worker or Turn; stop it before deleting or rebinding its workspace",
        );
    }
  }
  updateProject(id: string, patch: { rootPath?: string | undefined; name?: string | undefined }) {
    this.getProject(id);
    if (patch.rootPath) {
      this.assertWorkspaceMutable(this.listConversations(id).map((c) => c.id));
      const duplicate = this.projectByRoot(patch.rootPath);
      if (duplicate && duplicate.id !== id)
        throw new AppError(409, "Project root already registered");
    }
    return this.db.transaction(() => {
      const value = this.db
        .update(schema.projects)
        .set({ ...patch, updatedAt: Date.now() })
        .where(eq(schema.projects.id, id))
        .returning()
        .get();
      if (patch.rootPath)
        this.db
          .update(schema.conversations)
          .set({ workspacePath: patch.rootPath, updatedAt: Date.now() })
          .where(
            and(
              eq(schema.conversations.projectId, id),
              eq(schema.conversations.workspaceMode, "shared"),
            ),
          )
          .run();
      return { value, event: this.record("project.updated", id) };
    });
  }
  deleteProject(id: string) {
    this.getProject(id);
    this.assertWorkspaceMutable(this.listConversations(id).map((c) => c.id));
    return this.db.transaction(() => {
      this.db.delete(schema.projects).where(eq(schema.projects.id, id)).run();
      return this.record("project.deleted", id);
    });
  }
  listConversations(projectId?: string) {
    return this.db
      .select()
      .from(schema.conversations)
      .where(projectId ? eq(schema.conversations.projectId, projectId) : undefined)
      .all();
  }
  getConversation(id: string) {
    const value = this.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, id))
      .get();
    if (!value) throw new AppError(404, "Conversation not found");
    return value;
  }
  addConversation(projectId: string, title: string) {
    const project = this.getProject(projectId);
    const now = Date.now();
    const value = {
      id: randomUUID(),
      projectId,
      title,
      workspaceMode: "shared" as const,
      workspacePath: project.rootPath,
      runtimeStatus: "IDLE" as const,
      createdAt: now,
      updatedAt: now,
    };
    return this.db.transaction(() => {
      this.db.insert(schema.conversations).values(value).run();
      return { value, event: this.record("conversation.created", value.id) };
    });
  }
  updateConversation(id: string, title: string) {
    this.getConversation(id);
    return this.db.transaction(() => {
      const value = this.db
        .update(schema.conversations)
        .set({ title, updatedAt: Date.now() })
        .where(eq(schema.conversations.id, id))
        .returning()
        .get();
      return { value, event: this.record("conversation.updated", id) };
    });
  }
  deleteConversation(id: string) {
    this.getConversation(id);
    this.assertWorkspaceMutable([id]);
    return this.db.transaction(() => {
      this.db.delete(schema.conversations).where(eq(schema.conversations.id, id)).run();
      return this.record("conversation.deleted", id);
    });
  }
  record(type: string, entityId: string): ChangeEvent {
    return this.db
      .insert(schema.changes)
      .values({ type, entityId, createdAt: Date.now() })
      .returning()
      .get() as ChangeEvent;
  }
  events(after: number, limit: number) {
    return this.db
      .select()
      .from(schema.changes)
      .where(gt(schema.changes.seq, after))
      .orderBy(schema.changes.seq)
      .limit(limit)
      .all();
  }
  draft(conversationId: string): Draft {
    this.getConversation(conversationId);
    const row = this.db
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.conversationId, conversationId))
      .get();
    return row
      ? { ...row, pendingSubmission: row.pendingSubmission ?? null }
      : { conversationId, text: "", revision: 0, pendingSubmission: null };
  }
  saveDraft(conversationId: string, input: Omit<Draft, "conversationId">): Draft {
    return this.db.transaction(() => {
      const current = this.draft(conversationId);
      if (current.revision !== input.revision)
        throw new AppError(409, "Draft changed in another client; local text was not overwritten");
      const row = { ...input, conversationId, revision: current.revision + 1 };
      this.db
        .insert(schema.drafts)
        .values(row)
        .onConflictDoUpdate({ target: schema.drafts.conversationId, set: row })
        .run();
      return row;
    });
  }
  consumeDraft(conversationId: string, requestId: string) {
    const draft = this.draft(conversationId);
    if (draft.pendingSubmission?.requestId === requestId)
      this.saveDraft(conversationId, {
        text: "",
        revision: draft.revision,
        pendingSubmission: null,
      });
  }
  preferences(): Preferences {
    const row = this.db
      .select()
      .from(schema.uiPreferences)
      .where(eq(schema.uiPreferences.id, 1))
      .get();
    return row
      ? {
          lastProjectId: row.lastProjectId,
          lastConversationId: row.lastConversationId,
          showActivity: row.showActivity,
        }
      : { lastProjectId: null, lastConversationId: null, showActivity: true };
  }
  savePreferences(patch: Partial<Preferences>) {
    return this.db.transaction(() => {
      const next = { ...this.preferences(), ...patch };
      if (next.lastConversationId) {
        const conversation = this.getConversation(next.lastConversationId);
        if (patch.lastProjectId !== undefined && patch.lastProjectId !== conversation.projectId) {
          if (patch.lastConversationId !== undefined)
            throw new AppError(400, "Recent Conversation does not belong to Project");
          next.lastConversationId = null;
        } else next.lastProjectId = conversation.projectId;
      }
      if (next.lastProjectId) this.getProject(next.lastProjectId);
      this.db
        .insert(schema.uiPreferences)
        .values({ id: 1, ...next })
        .onConflictDoUpdate({ target: schema.uiPreferences.id, set: next })
        .run();
      return next;
    });
  }
  activity(): Activity {
    const pending = this.db
      .select({ conversationId: schema.approvals.conversationId, count: sql<number>`count(*)` })
      .from(schema.approvals)
      .where(eq(schema.approvals.status, "PENDING"))
      .groupBy(schema.approvals.conversationId)
      .all();
    const active = this.db.select().from(schema.turns).where(sql`ended_at is null`).all();
    const pendingById = new Map(pending.map((p) => [p.conversationId, p.count]));
    const activeById = new Map(active.map((t) => [t.conversationId, t.id]));
    const items = this.listConversations()
      .filter((c) => c.runtimeStatus !== "IDLE")
      .map((c) => ({
        conversationId: c.id,
        projectId: c.projectId,
        status: c.runtimeStatus,
        activeTurnId: activeById.get(c.id) ?? null,
        pendingApprovals: pendingById.get(c.id) ?? 0,
      }));
    return {
      items,
      running: items.filter((i) => activeStates.has(i.status)).length,
      waitingApproval: pending.length,
      pendingApprovals: pending.reduce((n, p) => n + p.count, 0),
      problems: items.filter((i) => problemStates.has(i.status)).length,
    };
  }
  snapshot() {
    return this.db.transaction(() => ({
      projects: this.listProjects(),
      conversations: this.listConversations(),
      activity: this.activity(),
      cursor:
        this.db.select({ seq: sql<number>`coalesce(max(seq), 0)` }).from(schema.changes).get()
          ?.seq ?? 0,
    }));
  }
}

export { RuntimeStore } from "./runtime";
