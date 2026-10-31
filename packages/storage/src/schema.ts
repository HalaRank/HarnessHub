import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  runtimeStatus: text("runtime_status", { enum: ["IDLE"] })
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
