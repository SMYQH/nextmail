-- Keep only the newest webhook row per user before enforcing one row per account.
DELETE FROM `webhook`
WHERE `id` NOT IN (
	SELECT `id` FROM (
		SELECT `id`, ROW_NUMBER() OVER (
			PARTITION BY `user_id` ORDER BY `updated_at` DESC, `created_at` DESC, `id` DESC
		) AS `row_number` FROM `webhook`
	) WHERE `row_number` = 1
);--> statement-breakpoint
DROP INDEX `webhook_user_id_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_user_id_unique` ON `webhook` (`user_id`);
