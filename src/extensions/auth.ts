import { jwtVerify } from "jose";
import { IncomingMessage } from "http";

interface AuthContext {
  userId: string;
  pageId: string;
}

/**
 * Extract and verify Clerk JWT token from WebSocket connection
 */
export async function authenticateConnection(
  request: IncomingMessage,
  documentName: string
): Promise<AuthContext> {
  const url = new URL(request.url || "", `http://${request.headers.host}`);
  const token = url.searchParams.get("token");

  if (!token) {
    throw new Error("Authentication token required");
  }

  const clerkSecretKey = process.env.CLERK_SECRET_KEY;
  if (!clerkSecretKey) {
    throw new Error("CLERK_SECRET_KEY not configured");
  }

  try {
    // Verify the JWT token
    const secret = new TextEncoder().encode(clerkSecretKey);
    const { payload } = await jwtVerify(token, secret);

    const userId = payload.sub;
    if (!userId) {
      throw new Error("Invalid token: missing user ID");
    }

    // Document name should be in format: page:{pageId}
    const pageId = documentName.replace("page:", "");
    if (!pageId || documentName === pageId) {
      throw new Error("Invalid document name format");
    }

    return {
      userId,
      pageId,
    };
  } catch (error) {
    console.error("Authentication failed:", error);
    throw new Error("Invalid or expired token");
  }
}

/**
 * Verify user has access to the page
 */
export async function verifyPageAccess(
  userId: string,
  pageId: string
): Promise<boolean> {
  // Import Prisma client dynamically to avoid circular dependencies
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();

  try {
    // Get the page with workspace info
    const page = await prisma.page.findUnique({
      where: { id: pageId },
      include: {
        workspace: {
          include: {
            members: {
              where: { userId },
            },
          },
        },
      },
    });

    if (!page) {
      return false;
    }

    // Check if user is a member of the workspace
    const isMember = page.workspace.members.length > 0;
    return isMember;
  } finally {
    await prisma.$disconnect();
  }
}
