/**
 * One conversation thread shared by every way of asking Pluely something.
 *
 * Typed questions, screenshots and active listening each live in their own hook
 * (`useCompletion`, `useSystemAudio`) with their own React state and their own
 * saved conversation. Those hooks sit at different levels of the tree, so
 * neither can see the other's history — which meant a question heard by the mic
 * had no idea what you had just typed, and vice versa.
 *
 * This module is the single thread all of them send to the model. It is a plain
 * module-level store rather than a context on purpose: nothing renders from it,
 * so it needs no reactivity, and staying out of the provider tree keeps the
 * change away from the display and persistence paths that already work.
 */

export interface SharedMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Turns kept before the oldest are dropped. The whole thread is resent on every
 * request, so this bounds both latency and token spend on a long session.
 */
const MAX_MESSAGES = 40;

let messages: SharedMessage[] = [];

/** The thread to send as `history`, oldest first. */
export const getSharedHistory = (): SharedMessage[] => messages.map((m) => ({ ...m }));

/**
 * Records one completed exchange. Called once a response is final, so an
 * aborted or failed turn never pollutes the context of the next one.
 */
export const appendSharedTurn = (userMessage: string, assistantResponse: string): void => {
  const user = userMessage?.trim();
  const assistant = assistantResponse?.trim();
  if (!user || !assistant) return;

  messages = [...messages, { role: "user", content: user }, { role: "assistant", content: assistant }];

  if (messages.length > MAX_MESSAGES) {
    messages = messages.slice(messages.length - MAX_MESSAGES);
  }
};

/**
 * Replaces the thread wholesale. Used when a past conversation is reopened, so
 * the mic and screenshots continue that subject rather than the abandoned one.
 */
export const setSharedHistory = (next: SharedMessage[]): void => {
  const trimmed = next.filter((m) => m?.content?.trim());
  messages = trimmed.slice(Math.max(0, trimmed.length - MAX_MESSAGES));
};

/** Starts a new thread. Wired to the explicit "clear conversation" actions. */
export const resetSharedConversation = (): void => {
  messages = [];
};
