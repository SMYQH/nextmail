import { safeErrorMetadata } from "./safe-error"
import NextAuth from "next-auth"
import GitHub from "next-auth/providers/github"
import Google from "next-auth/providers/google"
import { DrizzleAdapter } from "@auth/drizzle-adapter"
import { createDb, Db } from "./db"
import { accounts, users, roles, userRoles } from "./schema"
import { eq } from "drizzle-orm"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { Permission, ROLES, Role } from "./permissions"
import CredentialsProvider from "next-auth/providers/credentials"
import { hashPassword, comparePassword, needsPasswordUpgrade } from "./password"
import { authSchema, AuthSchema } from "@/lib/validation"
import { generateAvatarUrl } from "./avatar"
import { getUserId } from "./apiKey"
import { verifyTurnstileToken } from "./turnstile"
import { CredentialsError } from "./credentials-error"
import { getOAuthProviderAvailability } from "./oauth-providers"
import { ASSIGN_DEFAULT_ROLE_SQL } from "./database-statements"

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  [ROLES.EMPEROR]: "皇帝（网站所有者）",
  [ROLES.DUKE]: "公爵（超级用户）",
  [ROLES.KNIGHT]: "骑士（高级用户）",
  [ROLES.CIVILIAN]: "平民（普通用户）",
}

const oauthProviders = getOAuthProviderAvailability()

const getDefaultRole = async (): Promise<Role> => {
  const defaultRole = await getCloudflareContext().env.SITE_CONFIG.get("DEFAULT_ROLE")

  if (
    defaultRole === ROLES.DUKE ||
    defaultRole === ROLES.KNIGHT ||
    defaultRole === ROLES.CIVILIAN
  ) {
    return defaultRole as Role
  }

  return ROLES.CIVILIAN
}

export async function findOrCreateRole(db: Db, roleName: Role) {
  let role = await db.query.roles.findFirst({
    where: eq(roles.name, roleName),
  })

  if (!role) {
    await db.insert(roles)
      .values({
        name: roleName,
        description: ROLE_DESCRIPTIONS[roleName],
      })
      .onConflictDoNothing({ target: roles.name })
    role = await db.query.roles.findFirst({ where: eq(roles.name, roleName) })
  }

  return role!
}

export async function assignRoleToUser(db: Db, userId: string, roleId: string) {
  await db.batch([
    db.delete(userRoles).where(eq(userRoles.userId, userId)),
    db.insert(userRoles).values({ userId, roleId }),
  ])
}

async function assignDefaultRoleIfMissing(userId: string, roleId: string) {
  await getCloudflareContext().env.DB.prepare(ASSIGN_DEFAULT_ROLE_SQL)
    .bind(userId, roleId, userId)
    .run()
}

export async function getUserRole(userId: string) {
  const db = createDb()
  const userRoleRecords = await db.query.userRoles.findMany({
    where: eq(userRoles.userId, userId),
    with: { role: true },
  })
  return userRoleRecords[0]?.role.name ?? ROLES.CIVILIAN
}

export async function hasEmperor() {
  const [emperor] = await createDb()
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(roles.name, ROLES.EMPEROR))
    .limit(1)
  return Boolean(emperor)
}

export async function checkPermission(permission: Permission) {
  return Boolean(await getUserId(permission))
}

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut
} = NextAuth(() => {
  try {
    return {
      secret: process.env.AUTH_SECRET,
      // OpenNext runs on Workers rather than Pages, so Auth.js cannot infer its trusted proxy environment.
      trustHost: true,
      logger: {
        error(error: Error) {
          console.error("[auth][error]", safeErrorMetadata(error))
        },
      },
      adapter: DrizzleAdapter(createDb(), {
        usersTable: users,
        accountsTable: accounts,
      }),
      providers: [
        ...(oauthProviders.github
          ? [
              GitHub({
                clientId: process.env.AUTH_GITHUB_ID,
                clientSecret: process.env.AUTH_GITHUB_SECRET,
                allowDangerousEmailAccountLinking: false,
              }),
            ]
          : []),
        ...(oauthProviders.google
          ? [
              Google({
                clientId: process.env.AUTH_GOOGLE_ID,
                clientSecret: process.env.AUTH_GOOGLE_SECRET,
                allowDangerousEmailAccountLinking: false,
              }),
            ]
          : []),
        CredentialsProvider({
          name: "Credentials",
          credentials: {
            action: { type: "text" },
            turnstileToken: { type: "text" },
            username: { label: "用户名", type: "text", placeholder: "请输入用户名" },
            password: { label: "密码", type: "password", placeholder: "请输入密码" },
          },
          async authorize(credentials) {
            if (!credentials) {
              throw new CredentialsError("invalid_input")
            }

            const { username, password, turnstileToken } = credentials as Record<string, string | undefined>

            let parsedCredentials: AuthSchema
            try {
              parsedCredentials = authSchema.parse({ username, password, turnstileToken })
            } catch {
              throw new CredentialsError("invalid_input")
            }

            const verification = await verifyTurnstileToken(parsedCredentials.turnstileToken)
            if (!verification.success) {
              if (verification.reason === "missing-token") {
                throw new CredentialsError("verification_required")
              }
              throw new CredentialsError("verification_failed")
            }

            const db = createDb()

            if (credentials.action === "register") {
              return register(parsedCredentials.username, parsedCredentials.password)
            }

            const user = await db.query.users.findFirst({
              where: eq(users.username, parsedCredentials.username),
            })

            if (!user) {
              throw new CredentialsError("invalid_credentials")
            }

            const isValid = await comparePassword(parsedCredentials.password, user.password as string)
            if (!isValid) {
              throw new CredentialsError("invalid_credentials")
            }

            if (user.password && needsPasswordUpgrade(user.password)) {
              await db.update(users).set({ password: await hashPassword(parsedCredentials.password) })
                .where(eq(users.id, user.id))
            }

            return {
              ...user,
              password: undefined,
            }
          },
        }),
      ],
      events: {
        async signIn({ user }) {
          if (!user.id) return

          try {
            const db = createDb()
            const existingRole = await db.query.userRoles.findFirst({
              where: eq(userRoles.userId, user.id),
            })

            if (existingRole) return

            const defaultRole = await getDefaultRole()
            const role = await findOrCreateRole(db, defaultRole)
            await assignDefaultRoleIfMissing(user.id, role.id)
          } catch (error) {
            console.error('Error assigning role:', safeErrorMetadata(error))
          }
        },
      },
      callbacks: {
        async jwt({ token, user }) {
          if (user) {
            token.id = user.id
            token.name = user.name || user.username
            token.username = user.username
            token.image = user.image || generateAvatarUrl(token.name as string)
          }
          return token
        },
        async session({ session, token }) {
          if (token && session.user) {
            session.user.id = token.id as string
            session.user.name = token.name as string
            session.user.username = token.username as string
            session.user.image = token.image as string

            const db = createDb()
            let userRoleRecords = await db.query.userRoles.findMany({
              where: eq(userRoles.userId, session.user.id),
              with: { role: true },
            })

            if (!userRoleRecords.length) {
              const defaultRole = await getDefaultRole()
              const role = await findOrCreateRole(db, defaultRole)
              await assignDefaultRoleIfMissing(session.user.id, role.id)
              userRoleRecords = await db.query.userRoles.findMany({
                where: eq(userRoles.userId, session.user.id),
                with: { role: true },
              })
            }

            session.user.roles = userRoleRecords.map(ur => ({
              name: ur.role.name,
            }))

            const userAccounts = await db.query.accounts.findMany({
              where: eq(accounts.userId, session.user.id),
            })

            session.user.providers = userAccounts.map(account => account.provider)
          }

          return session
        },
      },
      session: {
        strategy: "jwt",
      },
    }
  } catch (error) {
    console.error("[auth][initialization]", safeErrorMetadata(error))
    throw new Error("Authentication initialization failed")
  }
})

export async function register(username: string, password: string) {
  const db = createDb()

  const existing = await db.query.users.findFirst({
    where: eq(users.username, username)
  })

  if (existing) {
    throw new CredentialsError("username_taken")
  }

  const hashedPassword = await hashPassword(password)

  const [user] = await db.insert(users)
    .values({
      username,
      password: hashedPassword,
    })
    .onConflictDoNothing({ target: users.username })
    .returning({ id: users.id, username: users.username, name: users.name, image: users.image })

  if (!user) throw new CredentialsError("username_taken")

  return user
}
