import { Queue } from "bullmq";
import { Redis as RedisClient } from "ioredis";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

const redisUrl = process.env.BULLMQ_REDIS_URL || "redis://localhost:6379";
console.log("BULLMQ_REDIS_URL:", process.env.BULLMQ_REDIS_URL);
const connection = new RedisClient(redisUrl);

export interface SnapshotJobData {
  pageId: string;
  yjsState: Uint8Array;
  triggeredBy: string;
  timestamp: number;
}

/**
 * BullMQ queue for snapshot processing
 */
export const snapshotQueue = new Queue<SnapshotJobData>("snapshot", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
    removeOnComplete: {
      count: 100,
      age: 3600, // Keep completed jobs for 1 hour
    },
    removeOnFail: {
      count: 500,
      age: 86400, // Keep failed jobs for 24 hours
    },
  },
});

/**
 * Add a snapshot job to the queue
 */
export async function queueSnapshot(data: SnapshotJobData): Promise<void> {
  try {
    await snapshotQueue.add("process-snapshot", data, {
      priority: 1,
    });
    console.log(`✓ Queued snapshot for page ${data.pageId}`);
  } catch (error) {
    console.error("Failed to queue snapshot:", error);
    throw error;
  }
}

// Handle queue errors
snapshotQueue.on("error", (error) => {
  console.error("Snapshot queue error:", error);
});
