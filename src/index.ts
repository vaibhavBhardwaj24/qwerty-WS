import { Server } from "@hocuspocus/server";
import * as Y from "yjs";
import * as dotenv from "dotenv";
import crypto from "crypto";
import express from "express";
import { createRedisPersistence } from "./extensions/redis-persistence";
import { authenticateConnection, verifyPageAccess } from "./extensions/auth";
import { queueSnapshot } from "./queue/snapshot-queue";
import {
  serializeYDoc,
  yjsStateToBase64,
  base64ToYjsState,
} from "./utils/yjs-serializer";
import { prisma } from "./lib/prisma";
import { healthCheckHandler } from "./routes/health";

dotenv.config();

const port = parseInt(process.env.PORT || "1234", 10);

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const BULLMQ_REDIS_URL = process.env.BULLMQ_REDIS_URL || REDIS_URL;

// Feature flag: Use BullMQ queue (true) or direct save (false)
const USE_SNAPSHOT_QUEUE = process.env.USE_SNAPSHOT_QUEUE === "true";

// Track active connections per document
const activeConnections = new Map<string, Set<string>>();

// Track last snapshot hash per document (to avoid duplicate snapshots)
const lastSnapshotHash = new Map<string, string>();

/**
 * Calculate hash of Yjs state for change detection
 */
function calculateStateHash(state: Uint8Array): string {
  return crypto.createHash("sha256").update(state).digest("hex");
}

/**
 * Save snapshot directly to Postgres (no queue)
 */
async function saveSnapshotDirect(
  pageId: string,
  yjsState: string,
  triggeredBy: string,
  timestamp: number
): Promise<void> {
  const binaryState = base64ToYjsState(yjsState);

  await prisma.yjsSnapshot.create({
    data: {
      pageId,
      snapshot: Buffer.from(binaryState),
      version: Math.floor(timestamp / 1000),
      createdBy: triggeredBy,
    },
  });
}

const server = Server.configure({
  port,

  extensions: [createRedisPersistence()],

  async onAuthenticate(data: any) {
    console.log(data.documentName, "documentName");
    try {
      const {
        requestParameters,
        request,
        documentName: originalDocumentName,
      } = data;

      // Robust fallback extraction from URL
      let documentName = originalDocumentName;
      if (!documentName && request?.url) {
        const urlObj = new URL(
          request.url,
          `http://${request.headers.host || "localhost"}`
        );
        const path = urlObj.pathname;
        documentName = path.startsWith("/") ? path.substring(1) : path;
      }

      if (!documentName) {
        console.error("[onAuthenticate] CRITICAL: No document name found");
        throw new Error("Missing document context");
      }

      const pageId = documentName.replace("page:", "");
      const token =
        requestParameters?.get?.("token") || requestParameters?.token;
      const userId =
        requestParameters?.get?.("userId") || requestParameters?.userId;

      console.log(
        `[onAuthenticate] Attempt - User:${userId}, Page:${pageId}, Doc:${documentName}`
      );

      if (!token) throw new Error("Authentication token required");
      if (!userId) throw new Error("User ID required");

      const hasAccess = await verifyPageAccess(userId, pageId);
      if (!hasAccess) {
        console.warn(
          `[onAuthenticate] Access DENIED - User:${userId}, Page:${pageId}`
        );
        throw new Error("Access denied to this page");
      }

      console.log(
        `✓ [onAuthenticate] Success - User:${userId}, Doc:${documentName}`
      );

      return {
        documentName,
        user: {
          id: userId,
          name:
            requestParameters?.get?.("userName") ||
            requestParameters?.userName ||
            "Anonymous",
          color:
            requestParameters?.get?.("userColor") ||
            requestParameters?.userColor ||
            "#000000",
        },
      };
    } catch (error: any) {
      console.error("[onAuthenticate] Error:", error.message);
      throw error;
    }
  },

  async onConnect(data: any) {
    const { documentName, context, requestParameters } = data;
    if (!documentName) return;

    const pageId = documentName.replace("page:", "");
    const userId =
      context.user?.id ||
      requestParameters?.get?.("userId") ||
      requestParameters?.userId ||
      "anonymous";

    if (!activeConnections.has(pageId)) {
      activeConnections.set(pageId, new Set());
    }
    activeConnections.get(pageId)!.add(userId);

    console.log(
      `✓ [onConnect] User:${userId} on Page:${pageId} (${
        activeConnections.get(pageId)!.size
      } active)`
    );
  },

  async onDisconnect(data: any) {
    const { documentName, context, requestParameters } = data;
    if (!documentName) return;

    const pageId = documentName.replace("page:", "");
    const userId =
      context.user?.id ||
      requestParameters?.get?.("userId") ||
      requestParameters?.userId ||
      "anonymous";

    const connections = activeConnections.get(pageId);
    if (connections) {
      connections.delete(userId);
      console.log(
        `✓ [onDisconnect] User:${userId} from Page:${pageId} (${connections.size} remaining)`
      );

      if (connections.size === 0) {
        activeConnections.delete(pageId);

        try {
          const doc = await server.documents.get(documentName);
          if (doc) {
            const state = serializeYDoc(doc);
            const stateHash = calculateStateHash(state);
            const lastHash = lastSnapshotHash.get(pageId);

            // Only save snapshot if content changed
            if (stateHash !== lastHash) {
              const yjsStateBase64 = yjsStateToBase64(state);

              if (USE_SNAPSHOT_QUEUE) {
                // Queue to BullMQ worker
                await queueSnapshot({
                  pageId,
                  yjsState: yjsStateBase64,
                  triggeredBy: userId,
                  timestamp: Date.now(),
                });
                console.log(`✓ [onDisconnect] Snapshot queued for ${pageId}`);
              } else {
                // Save directly to Postgres
                await saveSnapshotDirect(
                  pageId,
                  yjsStateBase64,
                  userId,
                  Date.now()
                );
                console.log(
                  `✓ [onDisconnect] Snapshot saved directly for ${pageId}`
                );
              }

              lastSnapshotHash.set(pageId, stateHash);
            } else {
              console.log(
                `[onDisconnect] Skipping snapshot for ${pageId} (no changes)`
              );
            }
          }
        } catch (error) {
          console.error(`[onDisconnect] Snapshot failed for ${pageId}:`, error);
        }
      }
    }
  },

  async onDestroy(data: any) {
    const { documentName } = data;
    if (!documentName) return;
    const pageId = documentName.replace("page:", "");
    console.log(`[onDestroy] Document: ${pageId}`);
    activeConnections.delete(pageId);
    lastSnapshotHash.delete(pageId);
  },

  async onLoadDocument(data: any) {
    const { documentName } = data;
    if (!documentName) {
      console.warn("[onLoadDocument] Skipping: Empty documentName");
      return;
    }
    console.log(`[onLoadDocument] Loading: ${documentName}`);
  },

  async onStoreDocument(data: any) {
    const { documentName, document } = data;
    if (!documentName) return;

    console.log(`[onStoreDocument] Storing: ${documentName}`);
    try {
      const state = Y.encodeStateAsUpdate(document);
      console.log(
        `[onStoreDocument] ${documentName} size: ${state.byteLength} bytes`
      );
    } catch (err) {
      console.error(`[onStoreDocument] Failed ${documentName}:`, err);
    }
  },
});

server.listen();

// Create Express app for HTTP endpoints
const app = express();
const httpPort = parseInt(process.env.HTTP_PORT || "1235", 10);

// Health check endpoint
app.get("/health", healthCheckHandler);

// Start HTTP server
app.listen(httpPort, () => {
  console.log(`✓ HTTP server listening on port ${httpPort}`);
});

console.log("🚀 Hocuspocus WebSocket server started");
console.log(`   WebSocket Port: ${port}`);
console.log(`   HTTP Port: ${httpPort}`);
console.log(`   Redis: ${process.env.REDIS_URL || "redis://localhost:6379"}`);
console.log(
  `   Snapshots: ${
    USE_SNAPSHOT_QUEUE ? "BullMQ Queue" : "Direct Save"
  } (on disconnect)`
);

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
