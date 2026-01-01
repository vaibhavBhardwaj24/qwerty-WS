import { Redis } from "@hocuspocus/extension-redis";
import { Redis as RedisClient } from "ioredis";

/**
 * Create Redis persistence extension for Hocuspocus
 */
export function createRedisPersistence() {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  // const redisPassword = process.env.REDIS_PASSWORD;
  console.log(redisUrl);
  const redis = new RedisClient(redisUrl);

  redis.on("error", (err: Error) => {
    console.error("Redis connection error:", err);
  });

  redis.on("connect", () => {
    console.log("✓ Connected to Redis");
  });

  return new Redis({
    redis,
    // Store documents with prefix ydoc:
    prefix: "ydoc:",
  });
}
