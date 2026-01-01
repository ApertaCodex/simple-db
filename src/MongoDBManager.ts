import mongoose from 'mongoose';

export class MongoDBManager {
    async getCollections(connectionString: string): Promise<string[]> {
        const connection = await mongoose.createConnection(connectionString);
        try {
            await connection.asPromise();
            const db = connection.db;
            if (!db) {
                throw new Error('Database connection not established');
            }
            const collections = await db.listCollections().toArray();
            return collections.map(col => col.name);
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
