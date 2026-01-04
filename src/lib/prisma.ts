import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import * as dotenv from "dotenv";

// Ensure environment variables are loaded
dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is not set");
}

/**
 * Shared Prisma client instance configured with the necessary adapter for Prisma 7.
 * This is used across authentication extensions and background workers.
 */
const adapter = new PrismaPg({ connectionString });
export const prisma = new PrismaClient({ adapter });

// Optional: Test connection on startup
prisma
  .$connect()
  .then(() => {
    console.log("✓ Prisma connected to database");
  })
  .catch((error: unknown) => {
    console.error("✗ Prisma connection failed:", error);
  });
