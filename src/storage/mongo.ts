import { MongoClient } from 'mongodb';
import { ConfigurationError } from '../core/errors.ts';
import type { Db, Collection } from 'mongodb';
import type { LoggerLike } from '../types/core.ts';

interface MongoServiceOptions {
  uri?: string | undefined;
  dbName?: string | undefined;
  logger?: LoggerLike | undefined;
  maxPoolSize?: number;
  minPoolSize?: number;
  connectTimeoutMs?: number;
  serverSelectionTimeoutMs?: number;
}

export class MongoService {
  uri: string | undefined;
  dbName: string | undefined;
  logger: LoggerLike | undefined;
  maxPoolSize: number;
  minPoolSize: number;
  connectTimeoutMs: number;
  serverSelectionTimeoutMs: number;
  client: MongoClient | null;
  db: Db | null;

  constructor(options: MongoServiceOptions = {}) {
    this.uri = options.uri ?? undefined;
    this.dbName = options.dbName ?? undefined;
    this.logger = options.logger ?? undefined;
    this.maxPoolSize = options.maxPoolSize ?? 100;
    this.minPoolSize = options.minPoolSize ?? 5;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.serverSelectionTimeoutMs = options.serverSelectionTimeoutMs ?? 10_000;

    this.client = null;
    this.db = null;
  }

  async connect(): Promise<Db> {
    if (!this.uri) {
      throw new ConfigurationError('Missing MongoDB connection URI (MONGODB_URI)');
    }

    if (!this.dbName) {
      throw new ConfigurationError('Missing MongoDB database name (MONGODB_DB)');
    }

    if (this.client && this.db) return this.db;

    this.client = new MongoClient(this.uri, {
      maxPoolSize: this.maxPoolSize,
      minPoolSize: this.minPoolSize,
      connectTimeoutMS: this.connectTimeoutMs,
      socketTimeoutMS: this.connectTimeoutMs,
      serverSelectionTimeoutMS: this.serverSelectionTimeoutMs,
      retryWrites: true,
    });

    await this.client.connect();
    this.db = this.client.db(this.dbName);

    this.logger?.info?.('MongoDB connected', {
      dbName: this.dbName,
      maxPoolSize: this.maxPoolSize,
      minPoolSize: this.minPoolSize,
    });

    return this.db;
  }

  collection(name: string): Collection {
    if (!this.db) {
      throw new Error('MongoService is not connected yet');
    }

    return this.db.collection(name);
  }

  async close(): Promise<void> {
    if (!this.client) return;

    await this.client.close();
    this.logger?.info?.('MongoDB disconnected');

    this.client = null;
    this.db = null;
  }

  async ping(): Promise<void> {
    if (!this.db) {
      throw new Error('MongoService is not connected yet');
    }
    await this.db.command({ ping: 1 });
  }
}




