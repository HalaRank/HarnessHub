CREATE TABLE `new_conversation_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
