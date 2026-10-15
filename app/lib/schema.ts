import { integer, sqliteTable, text, primaryKey, uniqueIndex, index } from "drizzle-orm/sqlite-core"
import type { AdapterAccountType } from "next-auth/adapters"
import { relations, sql } from 'drizzle-orm';

// https://authjs.dev/getting-started/adapters/drizzle
export const users = sqliteTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: integer("emailVerified", { mode: "timestamp_ms" }),
  image: text("image"),
  username: text("username").unique(),
  password: text("password"),
})
export const accounts = sqliteTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => ({
    compoundKey: primaryKey({
      columns: [account.provider, account.providerAccountId],
    }),
    userIdIdx: index("account_user_id_idx").on(account.userId),
  })
)

export const emails = sqliteTable("email", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  address: text("address").notNull().unique(),
  userId: text("userId").references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => ({
  expiresAtIdx: index("email_expires_at_idx").on(table.expiresAt),
  userIdIdx: index("email_user_id_idx").on(table.userId),
  addressLowerIdx: uniqueIndex("email_address_lower_idx").on(sql`LOWER(${table.address})`),
}))

export const messages = sqliteTable("message", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  emailId: text("emailId")
    .notNull()
    .references(() => emails.id, { onDelete: "cascade" }),
  fromAddress: text("from_address"),
  toAddress: text("to_address"),
  subject: text("subject").notNull(),
  content: text("content").notNull(),
  html: text("html"),
  type: text("type"),
  isRead: integer("is_read", { mode: "boolean" }).notNull().default(false),
  receivedAt: integer("received_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  sentAt: integer("sent_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => ({
  emailIdIdx: index("message_email_id_idx").on(table.emailId),
  emailReadIdx: index("message_email_read_idx").on(table.emailId, table.isRead, table.type),
  emailIdReceivedAtTypeIdx: index("message_email_id_received_at_type_idx").on(table.emailId, table.receivedAt, table.type),
}))

// Stable routing survives mailbox renames and configuration-store retries.
export const catchAllMailboxes = sqliteTable("catch_all_mailbox", {
  domain: text("domain").primaryKey(),
  emailId: text("email_id").notNull().unique()
    .references(() => emails.id, { onDelete: "cascade" }),
})

// The insert trigger assigns an order independent of delivery timestamps and UUIDs.
export const messageArrivals = sqliteTable("message_arrival", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  messageId: text("message_id").notNull().unique()
    .references(() => messages.id, { onDelete: "cascade" }),
})

export const webhooks = sqliteTable('webhook', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  url: text('url').notNull(),
  secret: text('secret'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => ({
  userIdIdx: index('webhook_user_id_idx').on(table.userId),
}))

export const roles = sqliteTable("role", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull().unique(),
  description: text("description"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const userRoles = sqliteTable("user_role", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  roleId: text("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.roleId] }),
  userIdIdx: index("user_role_user_id_idx").on(table.userId),
}));

export const userEmailDomainAccess = sqliteTable("user_email_domain_access", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  domains: text("domains").notNull(),
});

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  key: text('key').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
}, (table) => ({
  nameUserIdUnique: uniqueIndex('name_user_id_unique').on(table.name, table.userId),
  userIdIdx: index('api_keys_user_id_idx').on(table.userId),
}));

export const emailShares = sqliteTable('email_share', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  emailId: text('email_id')
    .notNull()
    .references(() => emails.id, { onDelete: "cascade" }),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
}, (table) => ({
  emailIdIdx: index('email_share_email_id_idx').on(table.emailId),
  tokenIdx: index('email_share_token_idx').on(table.token),
}));

export const messageShares = sqliteTable('message_share', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  messageId: text('message_id')
    .notNull()
    .references(() => messages.id, { onDelete: "cascade" }),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
}, (table) => ({
  messageIdIdx: index('message_share_message_id_idx').on(table.messageId),
  tokenIdx: index('message_share_token_idx').on(table.token),
}));



export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, {
    fields: [apiKeys.userId],
    references: [users.id],
  }),
}));

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, {
    fields: [userRoles.userId],
    references: [users.id],
  }),
  role: one(roles, {
    fields: [userRoles.roleId],
    references: [roles.id],
  }),
}));

export const userEmailDomainAccessRelations = relations(userEmailDomainAccess, ({ one }) => ({
  user: one(users, {
    fields: [userEmailDomainAccess.userId],
    references: [users.id],
  }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  userRoles: many(userRoles),
  emailDomainAccess: many(userEmailDomainAccess),
  apiKeys: many(apiKeys),
}));

export const rolesRelations = relations(roles, ({ many }) => ({
  userRoles: many(userRoles),
}));

export const emailSharesRelations = relations(emailShares, ({ one }) => ({
  email: one(emails, {
    fields: [emailShares.emailId],
    references: [emails.id],
  }),
}));

export const messageSharesRelations = relations(messageShares, ({ one }) => ({
  message: one(messages, {
    fields: [messageShares.messageId],
    references: [messages.id],
  }),
}));

// Usage survives deletion of sent messages and mailboxes.
export const sendUsage = sqliteTable("send_usage", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  day: text("day").notNull(),
  used: integer("used").notNull().default(0),
}, table => ({ pk: primaryKey({ columns: [table.userId, table.day] }) }))
