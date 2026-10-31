CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`native_session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`acp_request_id` text NOT NULL,
	`request_json` text NOT NULL,
	`status` text NOT NULL,
	`selected_option_id` text,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`native_session_id`) REFERENCES `native_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approval_request` ON `approvals` (`native_session_id`,`acp_request_id`);--> statement-breakpoint
CREATE TABLE `conversation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`native_session_id` text,
	`turn_id` text,
	`seq` integer NOT NULL,
	`raw_event_json` text,
	`normalized_kind` text NOT NULL,
	`normalized_payload_json` text,
	`origin` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`native_session_id`) REFERENCES `native_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_event_seq` ON `conversation_events` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE TABLE `harness_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`profile` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `native_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`harness_id` text NOT NULL,
	`agent_session_id` text,
	`worker_id` text NOT NULL,
	`epoch` text NOT NULL,
	`status` text NOT NULL,
	`capabilities` text,
	`cwd` text NOT NULL,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `turns` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`native_session_id` text,
	`request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`harness_id` text NOT NULL,
	`state` text NOT NULL,
	`stop_reason` text,
	`start_event_seq` integer,
	`finish_event_seq` integer,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`native_session_id`) REFERENCES `native_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turns_request_id_unique` ON `turns` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `one_active_turn` ON `turns` (`conversation_id`) WHERE ended_at is null;