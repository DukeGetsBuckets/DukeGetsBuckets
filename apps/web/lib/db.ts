import { getPrisma } from "@tempo/database";

export const prisma = getPrisma();
export type { PrismaClient } from "@tempo/database";
