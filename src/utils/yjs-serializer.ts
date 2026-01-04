import * as Y from "yjs";
import crypto from "crypto";

export interface BlockData {
  id: string;
  type: string;
  content: any;
  parentId: string | null;
  order: number;
}

/**
 * Generate a deterministic ID for a block based on its content
 */
function generateBlockId(
  type: string,
  order: number,
  textContent: string
): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${type}-${order}-${textContent}`)
    .digest("hex");
  return hash.substring(0, 16); // Use first 16 chars for readability
}

/**
 * Convert Yjs document (Tiptap/ProseMirror) to array of blocks
 */
export function yjsToBlocks(ydoc: Y.Doc): BlockData[] {
  const blocks: BlockData[] = [];

  try {
    // Tiptap stores content in an XmlFragment called 'default'
    const fragment = ydoc.getXmlFragment("default");

    if (!fragment) {
      console.warn("[yjsToBlocks] No 'default' fragment found in Yjs document");
      return blocks;
    }

    let order = 0;

    // Iterate through all nodes in the fragment
    fragment.forEach((item) => {
      if (item instanceof Y.XmlElement) {
        const nodeName = item.nodeName;
        const attrs = item.getAttributes();

        // Extract text content
        let textContent = "";
        const extractText = (node: Y.XmlElement | Y.XmlText): void => {
          if (node instanceof Y.XmlText) {
            textContent += node.toString();
          } else if (node instanceof Y.XmlElement) {
            node.forEach((child) => extractText(child as any));
          }
        };
        extractText(item);

        // Create block data with deterministic ID
        const block: BlockData = {
          id: generateBlockId(nodeName, order, textContent),
          type: nodeName, // e.g., 'paragraph', 'heading', 'bulletList'
          content: {
            text: textContent,
            attrs: attrs,
          },
          parentId: null,
          order: order++,
        };

        blocks.push(block);
      }
    });

    console.log(
      `[yjsToBlocks] Extracted ${blocks.length} blocks from Tiptap content`
    );
  } catch (error) {
    console.error("[yjsToBlocks] Error extracting blocks:", error);
  }

  return blocks;
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
