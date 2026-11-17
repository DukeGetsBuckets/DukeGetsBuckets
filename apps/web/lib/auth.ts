import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { username } from "better-auth/plugins";
import { APP_NAME, RATING_DEFAULTS, SOCIAL_RULES } from "@tempo/shared";
import { prisma } from "./db";
import { emailLayout, sendMail } from "./mailer";

const isProd = process.env.NODE_ENV === "production";
const webUrl = process.env.NEXT_PUBLIC_WEB_URL ?? "http://localhost:3000";
const trusted = [webUrl, ...(process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)];

export const auth = betterAuth({
  appName: APP_NAME,
  baseURL: process.env.BETTER_AUTH_URL ?? webUrl,
  secret: process.env.BETTER_AUTH_SECRET,
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  trustedOrigins: Array.from(new Set(trusted)),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === "true",
    resetPasswordTokenExpiresIn: 60 * 60,
    sendResetPassword: async ({ user, url }) => {
      await sendMail({
        to: user.email,
        subject: `Reset your ${APP_NAME} password`,
        text: `Reset your password: ${url}\n\nIf you did not request this, you can ignore this email.`,
        html: emailLayout("Reset your password", "Use the button below to choose a new password. The link expires in one hour.", { label: "Reset password", url }),
      });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60 * 24,
    sendVerificationEmail: async ({ user, url }) => {
      await sendMail({
        to: user.email,
        subject: `Verify your ${APP_NAME} email`,
        text: `Welcome to ${APP_NAME}! Verify your email: ${url}`,
        html: emailLayout("Verify your email", `Welcome to ${APP_NAME}. Confirm your email address to secure your account.`, { label: "Verify email", url }),
      });
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-in/username": { window: 60, max: 10 },
      "/sign-up/email": { window: 60, max: 5 },
      "/request-password-reset": { window: 60, max: 3 },
    },
  },
  advanced: {
    cookiePrefix: "tempo",
    useSecureCookies: isProd,
    defaultCookieAttributes: { sameSite: "lax", httpOnly: true },
  },
  user: {
    changeEmail: { enabled: false },
    deleteUser: { enabled: false },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          // Every account starts with provisional ratings in each category and default settings.
          await prisma.$transaction([
            prisma.userSettings.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} }),
            ...(["BULLET", "BLITZ", "RAPID"] as const).map((category) =>
              prisma.rating.upsert({
                where: { userId_category: { userId: user.id, category } },
                create: {
                  userId: user.id,
                  category,
                  rating: RATING_DEFAULTS.startRating,
                  deviation: RATING_DEFAULTS.startDeviation,
                  volatility: RATING_DEFAULTS.startVolatility,
                  peakRating: RATING_DEFAULTS.startRating,
                },
                update: {},
              }),
            ),
          ]);
        },
      },
    },
  },
  plugins: [
    username({
      minUsernameLength: SOCIAL_RULES.usernameMin,
      maxUsernameLength: SOCIAL_RULES.usernameMax,
      usernameValidator: (u) => SOCIAL_RULES.usernameRegex.test(u) && !(SOCIAL_RULES.reservedUsernames as readonly string[]).includes(u.toLowerCase()),
    }),
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
