/**
 * The parent links between conversations, made safe to walk.
 *
 * A conversation may name a parent, and the pair walks that chain — to decide what is
 * archived, and to render the tree. Persisted state is not trusted to be a tree: a parent may
 * have been deleted, and a chain restored from an older shape may close on itself. A walk over
 * either would not terminate, so both are broken here by dropping the link rather than by
 * bounding every reader.
 *
 * Archival then flows down the chain until it settles, because a conversation shown under an
 * archived parent has to be archived too, however deep it sits.
 */
import type { ConversationSummary } from "../webview/protocol";

export const normalizeConversationTree = (
  conversations: ConversationSummary[],
): ConversationSummary[] => {
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  conversations.forEach((conversation) => {
    const seen = new Set([conversation.id]);
    let parentId = conversation.parentConversationId;
    while (parentId) {
      const parent = byId.get(parentId);
      if (!parent || seen.has(parentId)) {
        delete conversation.parentConversationId;
        return;
      }
      seen.add(parentId);
      parentId = parent.parentConversationId;
    }
  });
  let changed = true;
  while (changed) {
    changed = false;
    conversations.forEach((conversation) => {
      const parent = conversation.parentConversationId
        ? byId.get(conversation.parentConversationId)
        : undefined;
      if (parent && conversation.archived !== parent.archived) {
        conversation.archived = parent.archived;
        changed = true;
      }
    });
  }
  return conversations;
};
