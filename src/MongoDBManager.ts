import mongoose from 'mongoose';

export class MongoDBManager {
    async getCollections(connectionString: string): Promise<string[]> {
        const connection = await mongoose.createConnection(connectionString);
        try {
            if (!connection.db) {
                throw new Error('Database connection not established');
            }
            const collections = await connection.db.listCollections().toArray();
            return collections.map(col => col.name);
        } finally {
            await connection.close();
        }
    }

    async getCollectionData(connectionString: string, collectionName: string): Promise<any[]> {
        const connection = await mongoose.createConnection(connectionString);
        try {
            if (!connection.db) {
                throw new Error('Database connection not established');
            }
            const collection = connection.db.collection(collectionName);
            const data = await collection.find({}).limit(1000).toArray();
            return data;
        } finally {
            await connection.close();
        }
    }

    async executeQuery(connectionString: string, collectionName: string, filter: any = {}, limit: number = 1000): Promise<any[]> {
        const connection = await mongoose.createConnection(connectionString);
        try {
            if (!connection.db) {
                throw new Error('Database connection not established');
            }
            const collection = connection.db.collection(collectionName);
            const data = await collection.find(filter).limit(limit).toArray();
            return data;
        } finally {
            await connection.close();
        }
    }
}
