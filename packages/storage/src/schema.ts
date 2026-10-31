import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  rootPath: text("root_path").notNull().unique(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  workspaceMode: text("workspace_mode", { enum: ["shared"] })
    .notNull()
    .default("shared"),
  workspacePath: text("workspace_path").notNull(),
  runtimeStatus: text("runtime_status")
    .$type<import("@harnesshub/shared").RuntimeStatus>()
    .notNull()
    .default("IDLE"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
// Phase-1 metadata invalidations. Native conversation events are a separate phase-2 model.
export const changes = sqliteTable("metadata_changes", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  entityId: text("entity_id").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const harnessProfiles = sqliteTable("harness_profiles", {
  id: text("id").primaryKey(),
  profile: text("profile", { mode: "json" })
    .$type<import("@harnesshub/shared").HarnessProfile>()
    .notNull(),
});
export const nativeSessions = sqliteTable("native_sessions", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  harnessId: text("harness_id").notNull(),
  agentSessionId: text("agent_session_id"),
  workerId: text("worker_id").notNull(),
  epoch: text("epoch").notNull(),
  status: text("status").notNull(),
  capabilities: text("capabilities", { mode: "json" }).$type<unknown>(),
  cwd: text("cwd").notNull(),
  createdAt: integer("created_at").notNull(),
  endedAt: integer("ended_at"),
});
export const turns = sqliteTable(
  "turns",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    nativeSessionId: text("native_session_id").references(() => nativeSessions.id, {
      onDelete: "cascade",
    }),
    requestId: text("request_id").notNull().unique(),
    requestHash: text("request_hash").notNull(),
    harnessId: text("harness_id").notNull(),
    state: text("state").notNull(),
    stopReason: text("stop_reason"),
    startEventSeq: integer("start_event_seq"),
    finishEventSeq: integer("finish_event_seq"),
    createdAt: integer("created_at").notNull(),
    endedAt: integer("ended_at"),
  },
  (t) => [uniqueIndex("one_active_turn").on(t.conversationId).where(sql`ended_at is null`)],
);
export const conversationEvents = sqliteTable(
  "conversation_events",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    nativeSessionId: text("native_session_id").references(() => nativeSessions.id, {
      onDelete: "cascade",
    }),
    turnId: text("turn_id").references(() => turns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    raw: text("raw_event_json", { mode: "json" }).$type<unknown>(),
    kind: text("normalized_kind").notNull(),
    payload: text("normalized_payload_json", { mode: "json" }).$type<unknown>(),
    origin: text("origin", { enum: ["agent", "client", "runtime"] }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("conversation_event_seq").on(t.conversationId, t.seq)],
);
export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    nativeSessionId: text("native_session_id")
      .notNull()
      .references(() => nativeSessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    acpRequestId: text("acp_request_id").notNull(),
    request: text("request_json", { mode: "json" }).$type<unknown>().notNull(),
    status: text("status").notNull(),
    selectedOptionId: text("selected_option_id"),
    createdAt: integer("created_at").notNull(),
    endedAt: integer("ended_at"),
  },
  (t) => [uniqueIndex("approval_request").on(t.nativeSessionId, t.acpRequestId)],
);
