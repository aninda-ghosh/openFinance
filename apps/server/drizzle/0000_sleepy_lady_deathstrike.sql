CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`currency` text DEFAULT 'INR',
	`balance` real DEFAULT 0,
	`institution` text,
	`is_active` integer DEFAULT true,
	`created_at` text,
	`updated_at` text
);
--> statement-breakpoint
CREATE TABLE `ai_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`created_at` text,
	`updated_at` text
);
--> statement-breakpoint
CREATE TABLE `ai_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`confidence` text,
	`sources_json` text,
	`created_at` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `ai_conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `ai_tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`params_json` text NOT NULL,
	`result_json` text NOT NULL,
	`called_at` text,
	FOREIGN KEY (`message_id`) REFERENCES `ai_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `budget_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`envelope_id` text NOT NULL,
	`type` text NOT NULL,
	`threshold_pct` real NOT NULL,
	`is_active` integer DEFAULT true,
	`triggered_at` text,
	FOREIGN KEY (`envelope_id`) REFERENCES `envelopes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `envelope_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0,
	`created_at` text
);
--> statement-breakpoint
CREATE TABLE `envelopes` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`name` text NOT NULL,
	`budgeted` real DEFAULT 0,
	`spent` real DEFAULT 0,
	`month` text NOT NULL,
	`rollover_type` text DEFAULT 'none',
	`rollover_amount` real DEFAULT 0,
	`created_at` text,
	FOREIGN KEY (`group_id`) REFERENCES `envelope_groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `exchange_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`from_currency` text NOT NULL,
	`rate_to_inr` real NOT NULL,
	`source` text,
	`fetched_at` text
);
--> statement-breakpoint
CREATE TABLE `investments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`asset_type` text NOT NULL,
	`currency` text DEFAULT 'INR',
	`purchase_value` real NOT NULL,
	`units` real,
	`purchase_date` text NOT NULL,
	`current_value` real NOT NULL,
	`current_value_source` text,
	`current_value_at` text,
	`notes` text,
	`created_at` text,
	`updated_at` text
);
--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`policy_number` text,
	`start_date` text NOT NULL,
	`premium_amount` real NOT NULL,
	`premium_frequency` text NOT NULL,
	`premium_term_years` integer NOT NULL,
	`policy_term_years` integer NOT NULL,
	`maturity_date` text NOT NULL,
	`sum_assured` real NOT NULL,
	`maturity_value` real NOT NULL,
	`surrender_value` real,
	`notes` text,
	`created_at` text,
	`updated_at` text
);
--> statement-breakpoint
CREATE TABLE `policy_payouts` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_id` text NOT NULL,
	`payout_date` text NOT NULL,
	`amount` real NOT NULL,
	`label` text NOT NULL,
	`is_received` integer DEFAULT false,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `price_history` (
	`id` text PRIMARY KEY NOT NULL,
	`investment_id` text NOT NULL,
	`price` real NOT NULL,
	`source_url` text,
	`fetched_at` text,
	FOREIGN KEY (`investment_id`) REFERENCES `investments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`envelope_id` text,
	`payee` text NOT NULL,
	`amount` real NOT NULL,
	`type` text NOT NULL,
	`date` text NOT NULL,
	`notes` text,
	`import_hash` text,
	`created_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`envelope_id`) REFERENCES `envelopes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_import_hash_unique` ON `transactions` (`import_hash`);