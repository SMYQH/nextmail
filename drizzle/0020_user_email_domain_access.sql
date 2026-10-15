CREATE TABLE `user_email_domain_access` (
	`user_id` text PRIMARY KEY NOT NULL,
	`domains` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
