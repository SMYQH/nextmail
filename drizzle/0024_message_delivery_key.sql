ALTER TABLE `message` ADD `delivery_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `message_delivery_key_unique` ON `message` (`delivery_key`);