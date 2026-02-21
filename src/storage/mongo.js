import { MongoClient } from 'mongodb';
import { ConfigurationError } from '../core/errors.js';

export class MongoService {
  constructor(options = {}) {
    this.uri = options.uri;
    this.dbName = options.dbName;
    this.logger = options.logger;

    this.maxPoolSize = options.maxPoolSize ?? 100;
    this.minPoolSize = options.minPoolSize ?? 5;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.serverSelectionTimeoutMs = options.serverSelectionTimeoutMs ?? 10_000;

    this.client = null;
    this.db = null;
  }

  async connect() {
    if (!this.uri) {
      throw new ConfigurationError('Missing MongoDB connection URI (MONGODB_URI)');
    }

    if (!this.dbName) {
      throw new ConfigurationError('Missing MongoDB database name (MONGODB_DB)');
    }

    if (this.client) return this.db;

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

  collection(name) {
    if (!this.db) {
      throw new Error('MongoService is not connected yet');
    }

    return this.db.collection(name);
  }

  async close() {
    if (!this.client) return;

    await this.client.close();
    this.logger?.info?.('MongoDB disconnected');

    this.client = null;
    this.db = null;
  }
}
