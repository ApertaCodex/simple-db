import mongoose from 'mongoose';
import { logger } from './logger';

export class MongoDBManager {
    async getCollections(connectionString: string): Promise<string[]> {
        logger.debug(`Connecting to MongoDB: ${connectionString}`);
        const connection = await mongoose.createConnection(connectionString);
        try {
            await connection.asPromise();
            const db = connection.db;
            if (!db) {
                logger.error('Database connection not established');
                throw new Error('Database connection not established');
            }
            const collections = await db.listCollections().toArray();
            const collectionNames = collections.map(col => col.name);
            logger.debug(`Found ${collectionNames.length} collections`);
            return collectionNames;
        } finally {
            await connection.close();
        }
    }

    async getCollectionData(connectionString: string, collectionName: string, limit: number = 1000, offset: number = 0): Promise<any[]> {
        const connection = await mongoose.createConnection(connectionString);
        try {
            await connection.asPromise();
            const db = connection.db;
            if (!db) {
                throw new Error('Database connection not established');
            }
            const collection = db.collection(collectionName);
            const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
            const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
            if (safeLimit === 0) {
                return [];
            }
            const data = await collection.find({}).skip(safeOffset).limit(safeLimit).toArray();
            return data;
        } finally {
            await connection.close();
        }
    }

    async getCollectionCount(connectionString: string, collectionName: string): Promise<number> {
        const connection = await mongoose.createConnection(connectionString);
        try {
            await connection.asPromise();
            const db = connection.db;
            if (!db) {
                throw new Error('Database connection not established');
            }
            const collection = db.collection(collectionName);
            return await collection.countDocuments({});
        } finally {
            await connection.close();
        }
    }

    async executeQuery(connectionString: string, collectionName: string, filter: any = {}, limit: number = 1000): Promise<any[]> {
        const connection = await mongoose.createConnection(connectionString);
        try {
            await connection.asPromise();
            const db = connection.db;
            if (!db) {
                throw new Error('Database connection not established');
            }
            const collection = db.collection(collectionName);
            const data = await collection.find(filter).limit(limit).toArray();
            return data;
        } finally {
            await connection.close();
        }
    }
}
