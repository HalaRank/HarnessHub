CREATE TABLE `conversation_drafts` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`pending_submission` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ui_preferences` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_project_id` text,
	`last_conversation_id` text,
	`show_activity` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`last_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`last_conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
