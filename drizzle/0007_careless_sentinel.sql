ALTER TABLE `user` ADD `username` text;--> statement-breakpoint
ALTER TABLE `user` ADD `password` text;--> statement-breakpoint
UPDATE `user`
SET `username` = (SELECT `username` FROM `credential` WHERE `credential`.`userId` = `user`.`id` ORDER BY `created_at`, `id` LIMIT 1),
    `password` = (SELECT `password` FROM `credential` WHERE `credential`.`userId` = `user`.`id` ORDER BY `created_at`, `id` LIMIT 1)
WHERE EXISTS (SELECT 1 FROM `credential` WHERE `credential`.`userId` = `user`.`id`);--> statement-breakpoint
DROP TABLE `credential`;--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_unique` ON `user` (`username`);
