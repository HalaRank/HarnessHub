CREATE TABLE `handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`source_harness` text NOT NULL,
	`target_harness` text NOT NULL,
	`source_native_session_id` text NOT NULL,
	`target_native_session_id` text,
	`source_event_start` integer NOT NULL,
	`source_event_end` integer NOT NULL,
	`report_text` text,
	`fallback_text` text,
	`fallback_sources` text,
	`status` text NOT NULL,
	`first_target_request_id` text NOT NULL,
	`user_turn_id` text NOT NULL,
	`internal_turn_id` text,
	`user_message` text NOT NULL,
	`degraded` integer DEFAULT false NOT NULL,
	`confirmed_at` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`generated_at` integer,
	`committed_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_native_session_id`) REFERENCES `native_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_native_session_id`) REFERENCES `native_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`internal_turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `handoffs_first_target_request_id_unique` ON `handoffs` (`first_target_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `one_open_handoff` ON `handoffs` (`conversation_id`) WHERE status NOT IN ('COMMITTED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE `managed_worktrees` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`repository_path` text NOT NULL,
	`path` text NOT NULL,
	`branch` text NOT NULL,
	`owner_root` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `managed_worktrees_path_unique` ON `managed_worktrees` (`path`);--> statement-breakpoint
DROP INDEX `one_active_turn`;--> statement-breakpoint
ALTER TABLE `turns` ADD `origin` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `one_active_turn` ON `turns` (`conversation_id`) WHERE ended_at is null AND origin = 'user';--> statement-breakpoint
ALTER TABLE `conversation_events` ADD `purpose` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `active_native_session_id` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `selected_harness_id` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `worktree_id` text;--> statement-breakpoint
-- Schema 5 prohibited cross-Harness sessions; migrate its single chronological lineage once.
UPDATE conversations SET active_native_session_id = (
 SELECT id FROM native_sessions WHERE conversation_id = conversations.id ORDER BY created_at DESC, rowid DESC LIMIT 1
);
