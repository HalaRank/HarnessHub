CREATE TABLE `__new_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`title` text NOT NULL,
	`archived_at` integer,
	`workspace_mode` text DEFAULT 'shared' NOT NULL,
	`workspace_path` text NOT NULL,
	`active_native_session_id` text,
	`selected_harness_id` text,
	`worktree_id` text,
	`runtime_status` text DEFAULT 'IDLE' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_conversations`("id", "project_id", "title", "archived_at", "workspace_mode", "workspace_path", "active_native_session_id", "selected_harness_id", "worktree_id", "runtime_status", "created_at", "updated_at") SELECT "id", "project_id", "title", "archived_at", "workspace_mode", "workspace_path", "active_native_session_id", "selected_harness_id", "worktree_id", "runtime_status", "created_at", "updated_at" FROM `conversations`;--> statement-breakpoint
DROP TABLE `conversations`;--> statement-breakpoint
ALTER TABLE `__new_conversations` RENAME TO `conversations`;--> statement-breakpoint
CREATE TEMP TABLE `__hhu_foreign_key_check` (`violations` integer CHECK (`violations` = 0));--> statement-breakpoint
INSERT INTO `__hhu_foreign_key_check` SELECT count(*) FROM pragma_foreign_key_check;--> statement-breakpoint
DROP TABLE `__hhu_foreign_key_check`;
