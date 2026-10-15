CREATE TABLE `catch_all_mailbox` (
	`domain` text PRIMARY KEY NOT NULL,
	`email_id` text NOT NULL,
	FOREIGN KEY (`email_id`) REFERENCES `email`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catch_all_mailbox_email_id_unique` ON `catch_all_mailbox` (`email_id`);--> statement-breakpoint
CREATE TABLE `message_arrival` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_arrival_message_id_unique` ON `message_arrival` (`message_id`);
--> statement-breakpoint
INSERT INTO `message_arrival` (`message_id`)
SELECT `id` FROM `message` ORDER BY `rowid`;
--> statement-breakpoint
CREATE TRIGGER `message_record_arrival` AFTER INSERT ON `message`
BEGIN
  INSERT INTO `message_arrival` (`message_id`) VALUES (NEW.`id`);
END;
