import * as Y from "yjs";

export interface BlockData {
  id: string;
  type: string;
  content: any;
  parentId: string | null;
  order: number;
}

/**
 * Convert Yjs document to array of blocks
 */
export function yjsToBlocks(ydoc: Y.Doc): BlockData[] {
  const blocksMap = ydoc.getMap("blocks");
  const blocks: BlockData[] = [];

  blocksMap.forEach((value, key) => {
    const blockData = value as any;
    blocks.push({
      id: key,
      type: blockData.type || "paragraph",
      content: blockData.content || {},
      parentId: blockData.parentId || null,
      order: blockData.order || 0,
    });
  });

  // Sort by order
  return blocks.sort((a, b) => a.order - b.order);
}

/**
 * Convert array of blocks to Yjs document
 */
export function blocksToYjs(blocks: BlockData[]): Y.Doc {
  const ydoc = new Y.Doc();
  const blocksMap = ydoc.getMap("blocks");

  blocks.forEach((block) => {
    blocksMap.set(block.id, {
      type: block.type,
      content: block.content,
      parentId: block.parentId,
      order: block.order,
    });
  });

  return ydoc;
}

/**
 * Serialize Yjs document to Uint8Array
 */
export function serializeYDoc(ydoc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(ydoc);
}

/**
 * Deserialize Uint8Array to Yjs document
 */
export function deserializeYDoc(state: Uint8Array): Y.Doc {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, state);
  return ydoc;
}

/**
 * Get Yjs document state as base64 string (for database storage)
 */
export function yjsStateToBase64(state: Uint8Array): string {
  return Buffer.from(state).toString("base64");
}

/**
 * Convert base64 string to Yjs state
 */
export function base64ToYjsState(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}
