import mongoose from 'mongoose';
import { logger } from './logger';
import * as fs from 'fs';

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

    async getCollectionData(connectionString: string, collectionName: string, limit: number = 1000, offset: number = 0, sortConfig?: Array<{col: string, dir: 'asc' | 'desc'}>): Promise<any[]> {
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

            // Build sort object for MongoDB
            let cursor = collection.find({});
            if (sortConfig && sortConfig.length > 0) {
                const sortObj: Record<string, 1 | -1> = {};
                for (const sort of sortConfig) {
                    sortObj[sort.col] = sort.dir === 'desc' ? -1 : 1;
                }
                cursor = cursor.sort(sortObj);
            }

            const data = await cursor.skip(safeOffset).limit(safeLimit).toArray();
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

    async updateDocument(
        connectionString: string,
        collectionName: string,
        filter: any,
        update: { [field: string]: any }
    ): Promise<{ success: boolean; modifiedCount: number }> {
        const connection = await mongoose.createConnection(connectionString);
        try {
            await connection.asPromise();
            const db = connection.db;
            if (!db) {
                logger.error('Database connection not established');
                throw new Error('Database connection not established');
            }

            if (!filter || Object.keys(filter).length === 0) {
                throw new Error('Filter is required for safety - cannot update all documents');
            }

            if (!update || Object.keys(update).length === 0) {
                throw new Error('No fields to update');
            }

            const collection = db.collection(collectionName);
            
            // Use $set operator to update specific fields
            const updateOperation = { $set: update };
            
            logger.info(`Updating document in ${collectionName}`, { filter, update: updateOperation });
            
            const result = await collection.updateOne(filter, updateOperation);
            
            logger.info(`Modified ${result.modifiedCount} document(s) in ${collectionName}`);
            
            return {
                success: true,
                modifiedCount: result.modifiedCount
            };
        } catch (error) {
            logger.error(`Failed to update document in ${collectionName}`, error);
            throw error;
        } finally {
            await connection.close();
        }
    }

    async exportToJSON(connectionString: string, collectionName: string, outputPath: string, data?: any[]): Promise<string> {
        try {
            const exportData = data ?? await this.getCollectionData(connectionString, collectionName);
            const jsonData = JSON.stringify(exportData, null, 2);
            await fs.promises.writeFile(outputPath, jsonData, 'utf8');
            logger.info(`Exported ${exportData.length} documents from ${collectionName} to ${outputPath}`);
            return outputPath;
        } catch (error) {
            logger.error(`Failed to export collection ${collectionName} to JSON`, error);
            throw new Error(`Failed to export collection ${collectionName} to JSON: ${error}`);
        }
    }

    async exportToCSV(connectionString: string, collectionName: string, outputPath: string, data?: any[]): Promise<string> {
        try {
            const exportData = data ?? await this.getCollectionData(connectionString, collectionName);

            if (exportData.length === 0) {
                throw new Error(`No data to export`);
            }

            // Flatten nested objects and arrays for CSV
            const flattenedData = exportData.map(doc => this.flattenObject(doc));

            // Get all unique keys from all documents
            const allKeys = new Set<string>();
            flattenedData.forEach(doc => {
                Object.keys(doc).forEach(key => allKeys.add(key));
            });

            const headers = Array.from(allKeys);
            const csvRows = [headers.join(',')];

            for (const row of flattenedData) {
                const values = headers.map(header => {
                    const value = row[header];
                    if (value === null || value === undefined) {
                        return '';
                    }
                    const stringValue = String(value);
                    if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
                        return `"${stringValue.replace(/"/g, '""')}"`;
                    }
                    return stringValue;
                });
                csvRows.push(values.join(','));
            }

            const csvData = csvRows.join('\n');
            await fs.promises.writeFile(outputPath, csvData, 'utf8');
            logger.info(`Exported ${exportData.length} documents from ${collectionName} to ${outputPath}`);
            return outputPath;
        } catch (error) {
            logger.error(`Failed to export collection ${collectionName} to CSV`, error);
            throw new Error(`Failed to export collection ${collectionName} to CSV: ${error}`);
        }
    }

    private flattenObject(obj: any, prefix: string = ''): any {
        const flattened: any = {};

        for (const key in obj) {
            if (!obj.hasOwnProperty(key)) continue;

            const value = obj[key];
            const newKey = prefix ? `${prefix}.${key}` : key;

            if (value === null || value === undefined) {
                flattened[newKey] = value;
            } else if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
                // Recursively flatten nested objects
                Object.assign(flattened, this.flattenObject(value, newKey));
            } else if (Array.isArray(value)) {
                // Convert arrays to JSON strings
                flattened[newKey] = JSON.stringify(value);
            } else {
                flattened[newKey] = value;
            }
        }

        return flattened;
    }
}
