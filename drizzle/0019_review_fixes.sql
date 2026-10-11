CREATE TABLE `send_usage` (
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`used` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `day`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP INDEX `email_address_lower_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `email_address_lower_idx` ON `email` (LOWER("address"));--> statement-breakpoint
ALTER TABLE `webhook` ADD `secret` text;--> statement-breakpoint
UPDATE `webhook` SET `secret` = lower(hex(randomblob(32))) WHERE `secret` IS NULL;--> statement-breakpoint
-- Consolidate duplicate role definitions without losing user assignments.
INSERT OR IGNORE INTO user_role (user_id, role_id, created_at)
SELECT ur.user_id, (SELECT MIN(r2.id) FROM role r2 WHERE r2.name = r.name), ur.created_at
FROM user_role ur JOIN role r ON r.id = ur.role_id;
--> statement-breakpoint
DELETE FROM user_role WHERE role_id IN (
  SELECT id FROM role r WHERE id != (SELECT MIN(r2.id) FROM role r2 WHERE r2.name = r.name)
);
--> statement-breakpoint
DELETE FROM role WHERE id NOT IN (SELECT MIN(id) FROM role GROUP BY name);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_name_unique` ON `role` (`name`);
--> statement-breakpoint
UPDATE email SET address = LOWER(address);
--> statement-breakpoint
-- Seed durable usage from available sent records, using UTC days.
INSERT INTO send_usage (user_id, day, used)
SELECT e.userId, strftime('%Y-%m-%d', m.sent_at / 1000, 'unixepoch'), COUNT(*)
FROM message m JOIN email e ON e.id = m.emailId
WHERE m.type = 'sent' AND e.userId IS NOT NULL
GROUP BY e.userId, strftime('%Y-%m-%d', m.sent_at / 1000, 'unixepoch');
--> statement-breakpoint
CREATE TRIGGER single_emperor_insert BEFORE INSERT ON user_role
WHEN (SELECT name FROM role WHERE id = NEW.role_id) = 'emperor'
AND EXISTS (SELECT 1 FROM user_role WHERE role_id = NEW.role_id AND user_id != NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'Only one emperor is allowed'); END;
--> statement-breakpoint
CREATE TRIGGER single_emperor_update BEFORE UPDATE OF role_id, user_id ON user_role
WHEN (SELECT name FROM role WHERE id = NEW.role_id) = 'emperor'
AND EXISTS (SELECT 1 FROM user_role WHERE role_id = NEW.role_id AND user_id != OLD.user_id)
BEGIN SELECT RAISE(ABORT, 'Only one emperor is allowed'); END;
--> statement-breakpoint
-- Fail safely if historical data already has multiple emperors; do not choose an owner.
UPDATE user_role SET role_id = role_id WHERE role_id = (SELECT id FROM role WHERE name = 'emperor');
