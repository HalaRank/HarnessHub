import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeEvent } from "@harnesshub/shared";
import { AppError } from "@harnesshub/shared";
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
  updateProject(id: string, patch: { rootPath?: string | undefined; name?: string | undefined }) {
    this.getProject(id);
    if (patch.rootPath) {
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
  snapshot() {
    return this.db.transaction(() => ({
      projects: this.listProjects(),
      conversations: this.listConversations(),
      cursor:
        this.db.select({ seq: sql<number>`coalesce(max(seq), 0)` }).from(schema.changes).get()
          ?.seq ?? 0,
    }));
  }
}
