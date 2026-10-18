type Doc = Record<string, unknown>;

interface CursorLike {
  toArray(): Promise<Doc[]>;
}

export interface VoterStoreCollection {
  createIndex(index: Record<string, number>, options?: Doc): Promise<unknown> | unknown;
  find(filter: Doc, options?: Doc): CursorLike;
  updateOne(filter: Doc, update: Doc, options?: Doc): Promise<unknown>;
}

export interface VoterBatch {
  voterIds: string[];
  latestSeenAt: Date | null;
}

export interface VoterStore {
  load(botId: string, since: Date | null): Promise<VoterBatch>;
  add(botId: string, voterIds: readonly string[]): Promise<void>;
}

export class MongoVoterStore implements VoterStore {
  private readonly collection: VoterStoreCollection;
  private readonly now: () => Date;

  constructor(collection: VoterStoreCollection, now: () => Date = () => new Date()) {
    this.collection = collection;
    this.now = now;
  }

  async init(): Promise<void> {
    await this.collection.createIndex({ botId: 1, firstSeenAt: 1 });
  }

  async load(botId: string, since: Date | null): Promise<VoterBatch> {
    const filter: Doc = since ? { botId, firstSeenAt: { $gte: since } } : { botId };
    const docs = await this.collection.find(filter, { projection: { userId: 1, firstSeenAt: 1 } }).toArray();

    const voterIds: string[] = [];
    let latestSeenAt: Date | null = since;
    for (const doc of docs) {
      const userId = String(doc.userId ?? '').trim();
      if (userId) voterIds.push(userId);
      if (doc.firstSeenAt instanceof Date && (!latestSeenAt || doc.firstSeenAt > latestSeenAt)) {
        latestSeenAt = doc.firstSeenAt;
      }
    }
    return { voterIds, latestSeenAt };
  }

  async add(botId: string, voterIds: readonly string[]): Promise<void> {
    if (!voterIds.length) return;
    const firstSeenAt = this.now();
    await Promise.all(voterIds.map((userId) => this.collection.updateOne(
      { _id: `${botId}:${userId}` },
      { $setOnInsert: { botId, userId, firstSeenAt } },
      { upsert: true },
    )));
  }
}
