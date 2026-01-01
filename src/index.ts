import { Server } from "@hocuspocus/server";
import * as dotenv from "dotenv";
import { createRedisPersistence } from "./extensions/redis-persistence";
import { authenticateConnection, verifyPageAccess } from "./extensions/auth";
import { queueSnapshot } from "./queue/snapshot-queue";
import { serializeYDoc } from "./utils/yjs-serializer";

dotenv.config();

const port = parseInt(process.env.PORT || "1234", 10);

// Track active connections per document
const activeConnections = new Map<string, Set<string>>();

// Track periodic snapshot intervals
const snapshotIntervals = new Map<string, NodeJS.Timeout>();
const SNAPSHOT_INTERVAL = parseInt(
  process.env.SNAPSHOT_INTERVAL_MS || "300000",
  10
); // 5 minutes default

const server = Server.configure({
  port,

  extensions: [createRedisPersistence()],

  async onAuthenticate({
    documentName,
    requestHeaders,
    requestParameters,
    connection,
  }: {
    documentName: string;
    requestHeaders: any;
    requestParameters: URLSearchParams;
    connection: any;
  }) {
    try {
      // Extract token from connection request
      const token = requestParameters.get("token");
      if (!token) {
        throw new Error("Authentication token required");
      }

      // Verify token and extract user info
      const pageId = documentName.replace("page:", "");

      // For now, we'll do a simple verification
      // In production, you'd verify the JWT properly
      const userId = requestParameters.get("userId");
      if (!userId) {
        throw new Error("User ID required");
      }

      // Verify page access
      const hasAccess = await verifyPageAccess(userId, pageId);
      if (!hasAccess) {
        throw new Error("Access denied to this page");
      }

      // Store user info in connection context
      connection.readOnly = false;

      console.log(`✓ User ${userId} authenticated for page ${pageId}`);

      return {
        user: {
          id: userId,
          name: requestParameters.get("userName") || "Anonymous",
          color: requestParameters.get("userColor") || "#000000",
        },
      };
    } catch (error) {
      console.error("Authentication failed:", error);
      throw error;
    }
  },

  async onConnect({
    documentName,
    context,
  }: {
    documentName: string;
    context: any;
  }) {
    const pageId = documentName.replace("page:", "");
    const userId = context.user?.id || "anonymous";

    // Track connection
    if (!activeConnections.has(pageId)) {
      activeConnections.set(pageId, new Set());
    }
    activeConnections.get(pageId)!.add(userId);

    console.log(
      `✓ User ${userId} connected to page ${pageId} (${
        activeConnections.get(pageId)!.size
      } active)`
    );

    // Start periodic snapshots if this is the first connection
    if (activeConnections.get(pageId)!.size === 1) {
      const interval = setInterval(async () => {
        try {
          const doc = await server.documents.get(documentName);
          if (doc) {
            const state = serializeYDoc(doc);
            await queueSnapshot({
              pageId,
              yjsState: state,
              triggeredBy: "periodic",
              timestamp: Date.now(),
            });
          }
        } catch (error) {
          console.error("Periodic snapshot failed:", error);
        }
      }, SNAPSHOT_INTERVAL);

      snapshotIntervals.set(pageId, interval);
      console.log(`Started periodic snapshots for page ${pageId}`);
    }
  },

  async onDisconnect({
    documentName,
    context,
  }: {
    documentName: string;
    context: any;
  }) {
    const pageId = documentName.replace("page:", "");
    const userId = context.user?.id || "anonymous";

    // Remove connection
    const connections = activeConnections.get(pageId);
    if (connections) {
      connections.delete(userId);

      console.log(
        `✓ User ${userId} disconnected from page ${pageId} (${connections.size} remaining)`
      );

      // If this was the last connection, trigger snapshot and stop periodic snapshots
      if (connections.size === 0) {
        activeConnections.delete(pageId);

        // Clear periodic snapshot interval
        const interval = snapshotIntervals.get(pageId);
        if (interval) {
          clearInterval(interval);
          snapshotIntervals.delete(pageId);
          console.log(`Stopped periodic snapshots for page ${pageId}`);
        }

        // Trigger final snapshot
        try {
          const doc = await server.documents.get(documentName);
          if (doc) {
            const state = serializeYDoc(doc);
            await queueSnapshot({
              pageId,
              yjsState: state,
              triggeredBy: userId,
              timestamp: Date.now(),
            });
            console.log(`✓ Final snapshot queued for page ${pageId}`);
          }
        } catch (error) {
          console.error("Failed to queue final snapshot:", error);
        }
      }
    }
  },

  async onDestroy({ documentName }: any) {
    const pageId = documentName.replace("page:", "");
    console.log(`Document destroyed: ${pageId}`);

    // Clean up tracking
    activeConnections.delete(pageId);
    const interval = snapshotIntervals.get(pageId);
    if (interval) {
      clearInterval(interval);
      snapshotIntervals.delete(pageId);
    }
  },

  async onLoadDocument({ documentName }: any) {
    console.log(`Loading document: ${documentName}`);
  },

  async onStoreDocument({ documentName }: any) {
    console.log(`Storing document: ${documentName}`);
  },
});

server.listen();

console.log("🚀 Hocuspocus WebSocket server started");
console.log(`   Port: ${port}`);
console.log(`   Redis: ${process.env.REDIS_URL || "redis://localhost:6379"}`);
console.log(`   Snapshot interval: ${SNAPSHOT_INTERVAL}ms`);

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, closing server...");
  server.destroy();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received, closing server...");
  server.destroy();
  process.exit(0);
});
