import { Worker } from "bullmq";
import { prisma } from "../lib/prisma";
import IORedis from "ioredis";
import { SnapshotJobData } from "../queue/snapshot-queue";
import { base64ToYjsState } from "../utils/yjs-serializer";
import * as dotenv from "dotenv";

dotenv.config();

const redisUrl = process.env.BULLMQ_REDIS_URL || "redis://localhost:6379";
const redisPassword = process.env.REDIS_PASSWORD;

const connection = new IORedis(redisUrl, {
  password: redisPassword || undefined,
  maxRetriesPerRequest: null,
});

/**
 * Process snapshot jobs: Save Yjs state to Postgres
 */
const worker = new Worker<SnapshotJobData>(
  "snapshot",
  async (job) => {
    const { pageId, yjsState, triggeredBy, timestamp } = job.data;

    console.log(`Processing snapshot for page ${pageId}...`);

    try {
      // Decode Base64 to binary
      const binaryState = base64ToYjsState(yjsState);

      // Create snapshot record
      await prisma.yjsSnapshot.create({
        data: {
          pageId,
          snapshot: Buffer.from(binaryState),
          version: Math.floor(timestamp / 1000),
          createdBy: triggeredBy,
        },
      });

      console.log(`✓ Snapshot completed for page ${pageId}`);
      return { success: true };
    } catch (error) {
      console.error(`✗ Snapshot failed for page ${pageId}:`, error);
      throw error;
    }
  },
  {
    connection,
    concurrency: 5,
    limiter: {
      max: 10,
      duration: 1000,
    },
  }
);

// Worker event handlers
worker.on("completed", (job: any) => {
  console.log(`Job ${job.id} completed`);
});

worker.on("failed", (job: any, err: Error) => {
  console.error(`Job ${job?.id} failed:`, err);
});

worker.on("error", (err: Error) => {
  console.error("Worker error:", err);
});

console.log("🚀 Snapshot worker started");

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, closing worker...");
  await worker.close();
  await prisma.$disconnect();
  await connection.quit();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("SIGINT received, closing worker...");
  await worker.close();
  await prisma.$disconnect();
  await connection.quit();
  process.exit(0);
});
