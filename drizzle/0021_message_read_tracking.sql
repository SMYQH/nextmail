ALTER TABLE `message` ADD `is_read` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX `message_email_read_idx` ON `message` (`emailId`,`is_read`,`type`);
