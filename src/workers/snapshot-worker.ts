import { Worker } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import IORedis from "ioredis";
import { SnapshotJobData } from "../queue/snapshot-queue";
import { deserializeYDoc, yjsToBlocks } from "../utils/yjs-serializer";
import * as dotenv from "dotenv";

dotenv.config();

// Use the Prisma client from the main app (shares the same database)
// The client is generated in ../node_modules/.prisma/client
const connectionString = process.env.DATABASE_URL || "";
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const redisUrl = process.env.BULLMQ_REDIS_URL || "redis://localhost:6379";
const redisPassword = process.env.REDIS_PASSWORD;

const connection = new IORedis(redisUrl, {
  password: redisPassword || undefined,
  maxRetriesPerRequest: null,
});

/**
 * Process snapshot jobs: Convert Yjs state to Prisma blocks
 */
const worker = new Worker<SnapshotJobData>(
  "snapshot",
  async (job) => {
    const { pageId, yjsState, triggeredBy, timestamp } = job.data;

    console.log(`Processing snapshot for page ${pageId}...`);

    try {
      // Deserialize Yjs document
      const ydoc = deserializeYDoc(yjsState);
      const blocks = yjsToBlocks(ydoc);

      // Start transaction
      await prisma.$transaction(async (tx) => {
        // Get existing blocks for this page
        const existingBlocks = await tx.block.findMany({
          where: { pageId },
          select: { id: true },
        });

        const existingBlockIds = new Set(existingBlocks.map((b) => b.id));
        const newBlockIds = new Set(blocks.map((b) => b.id));

        // Delete blocks that no longer exist in Yjs
        const blocksToDelete = existingBlocks
          .filter((b) => !newBlockIds.has(b.id))
          .map((b) => b.id);

        if (blocksToDelete.length > 0) {
          await tx.block.deleteMany({
            where: {
              id: { in: blocksToDelete },
            },
          });
          console.log(`  Deleted ${blocksToDelete.length} blocks`);
        }

        // Upsert blocks from Yjs
        for (const block of blocks) {
          const isNew = !existingBlockIds.has(block.id);

          await tx.block.upsert({
            where: { id: block.id },
            create: {
              id: block.id,
              pageId,
              type: block.type,
              content: block.content,
              parentId: block.parentId,
              order: block.order,
              lastSyncedAt: new Date(),
            },
            update: {
              type: block.type,
              content: block.content,
              parentId: block.parentId,
              order: block.order,
              lastSyncedAt: new Date(),
            },
          });

          // Create version record for tracking
          if (!isNew) {
            await tx.blockVersion.create({
              data: {
                blockId: block.id,
                content: block.content,
                changedBy: triggeredBy,
              },
            });
          }
        }

        // Create snapshot record
        await tx.yjsSnapshot.create({
          data: {
            pageId,
            snapshot: Buffer.from(yjsState),
            version: Math.floor(timestamp / 1000),
            createdBy: triggeredBy,
          },
        });

        console.log(`  Upserted ${blocks.length} blocks`);
      });

      console.log(`✓ Snapshot completed for page ${pageId}`);
      return { success: true, blocksProcessed: blocks.length };
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
