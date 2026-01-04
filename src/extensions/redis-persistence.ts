import { Database } from "@hocuspocus/extension-database";
import { Redis as RedisClient } from "ioredis";
import { prisma } from "../lib/prisma";

/**
 * Create Redis persistence extension with Postgres fallback
 */
export function createRedisPersistence() {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const redis = new RedisClient(redisUrl);

  redis.on("error", (err: Error) => {
    console.error("Redis connection error:", err);
  });

  redis.on("connect", () => {
    console.log("✓ Connected to Redis for Persistence");
  });

  return new Database({
    fetch: async ({ documentName }) => {
      console.log(`[RedisPersistence] Fetching: ${documentName}`);

      // Try Redis first (fast path)
      const redisData = await redis.getBuffer(`ydoc_v2:${documentName}`);
      if (redisData) {
        console.log(
          `✓ [Redis] Cache HIT - Loaded from Redis (${redisData.length} bytes)`
        );
        return new Uint8Array(redisData);
      }

      // Fallback to Postgres (slower but reliable)
      console.log(`⚠ [Redis] Cache MISS - Checking Postgres...`);
      const pageId = documentName.replace("page:", "");

      const snapshot = await prisma.yjsSnapshot.findFirst({
        where: { pageId },
        orderBy: { createdAt: "desc" },
        select: { snapshot: true },
      });

      if (snapshot?.snapshot) {
        console.log(
          `✓ [Postgres] Found snapshot (${snapshot.snapshot.length} bytes)`
        );
        console.log(`→ [Redis] Restoring to cache with 1hr TTL`);
        // Convert Uint8Array to Buffer for Redis
        const buffer = Buffer.from(snapshot.snapshot);
        await redis.set(`ydoc_v2:${documentName}`, buffer, "EX", 3600);
        return new Uint8Array(buffer);
      }

      console.log(`ℹ [New Document] No data found - Starting fresh`);
      return null;
    },
    store: async ({ documentName, state }) => {
      console.log(
        `→ [Redis] Storing: ${documentName} (${state.byteLength} bytes, TTL: 1hr)`
      );
      // Set with 1 hour expiration (3600 seconds)
      await redis.set(
        `ydoc_v2:${documentName}`,
        Buffer.from(state),
        "EX",
        3600
      );
    },
  });
}
