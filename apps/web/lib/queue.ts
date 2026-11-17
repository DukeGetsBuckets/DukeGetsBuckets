import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { ANALYSIS_QUEUE, POSITION_QUEUE, type AnalysisJobData } from "@tempo/shared";

declare global {
  // eslint-disable-next-line no-var
  var __tempoQueues: { connection: Redis; analysis: Queue<AnalysisJobData>; position: Queue<AnalysisJobData>; positionEvents: QueueEvents; publisher: Redis } | undefined;
}

function init() {
  if (!globalThis.__tempoQueues) {
    const url = process.env.REDIS_URL ?? "redis://localhost:6379";
    const connection = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
    globalThis.__tempoQueues = {
      connection,
      analysis: new Queue<AnalysisJobData>(ANALYSIS_QUEUE, { connection }),
      position: new Queue<AnalysisJobData>(POSITION_QUEUE, { connection }),
      positionEvents: new QueueEvents(POSITION_QUEUE, { connection: new Redis(url, { maxRetriesPerRequest: null }) }),
      publisher: new Redis(url),
    };
  }
  return globalThis.__tempoQueues;
}

export function analysisQueue() {
  return init().analysis;
}
export function positionQueue() {
  return init().position;
}
export function positionEvents() {
  return init().positionEvents;
}
export async function publishEvent(event: Record<string, unknown>): Promise<void> {
  await init().publisher.publish("tempo:events", JSON.stringify(event));
}
