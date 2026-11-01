CREATE INDEX `api_keys_expires_at_idx` ON `api_keys` (`expires_at`);--> statement-breakpoint
CREATE INDEX `email_share_expires_at_idx` ON `email_share` (`expires_at`);--> statement-breakpoint
CREATE INDEX `message_share_expires_at_idx` ON `message_share` (`expires_at`);