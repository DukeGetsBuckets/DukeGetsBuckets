import type { ServerToClientEvents } from "@tempo/shared";

/** Abstraction over Socket.IO so the game engine can be unit-tested without sockets. */
export interface Emitter {
  toGame<E extends keyof ServerToClientEvents>(gameId: string, event: E, ...args: Parameters<ServerToClientEvents[E]>): void;
  toUser<E extends keyof ServerToClientEvents>(userId: string, event: E, ...args: Parameters<ServerToClientEvents[E]>): void;
}

export class NoopEmitter implements Emitter {
  toGame(): void {}
  toUser(): void {}
}
