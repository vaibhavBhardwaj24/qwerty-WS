import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import Redis from "ioredis";

interface ServiceStatus {
  status: "up" | "down" | "not_configured";
  message: string;
  responseTime?: number;
}

interface HealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  services: {
    postgres: ServiceStatus;
    redis: ServiceStatus;
  };
}

/**
 * Health check handler for the WebSocket server
 * Tests PostgreSQL and Redis connections
 */
export async function healthCheckHandler(
  req: Request,
  res: Response
): Promise<void> {
  const timestamp = new Date().toISOString();
  const services: HealthResponse["services"] = {
    postgres: { status: "down", message: "Not checked" },
    redis: { status: "down", message: "Not checked" },
  };

  // Check PostgreSQL
  try {
    const start = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    const responseTime = Date.now() - start;
    services.postgres = {
      status: "up",
      message: "Connected",
      responseTime,
    };
  } catch (error: any) {
    services.postgres = {
      status: "down",
      message: error.message || "Connection failed",
    };
  }

  // Check Redis
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    services.redis = {
      status: "not_configured",
      message: "Redis URL not configured",
    };
  } else {
    let redisClient: Redis | null = null;
    try {
      const start = Date.now();
      redisClient = new Redis(redisUrl);
      await redisClient.ping();
      const responseTime = Date.now() - start;
      services.redis = {
        status: "up",
        message: "Connected",
        responseTime,
      };
    } catch (error: any) {
      services.redis = {
        status: "down",
        message: error.message || "Connection failed",
      };
    } finally {
      if (redisClient) {
        await redisClient.quit();
      }
    }
  }

  // Determine overall status
  let overallStatus: HealthResponse["status"] = "healthy";
  if (services.postgres.status === "down") {
    overallStatus = "unhealthy";
  } else if (services.redis.status === "down") {
    overallStatus = "degraded";
  }

  const response: HealthResponse = {
    status: overallStatus,
    timestamp,
    services,
  };

  const statusCode = overallStatus === "unhealthy" ? 503 : 200;
  res.status(statusCode).json(response);
}
