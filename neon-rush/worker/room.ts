// Durable Object: a live multiplayer race room (stub — expanded in the multiplayer stage).
export class RaceRoom implements DurableObject {
  constructor(private state: DurableObjectState, private env: unknown) {}
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    ws.send(typeof message === 'string' ? message : 'binary');
  }
}
