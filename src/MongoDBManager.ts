import mongoose from 'mongoose';
import { logger } from './logger';
import * as fs from 'fs';
import { BaseDatabaseProvider } from './BaseDatabaseProvider';
import type { DatabaseType, SortConfig, UpdateResult } from './types';

export class MongoDBManager extends BaseDatabaseProvider {

    getType(): DatabaseType {
        return 'mongodb';
    }

    async getTableNames(connectionString: string): Promise<string[]> {
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

    async getTableData(connectionString: string, collectionName: string, limit: number = 1000, offset: number = 0, sortConfig?: SortConfig[]): Promise<any[]> {
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

    async getRowCount(connectionString: string, collectionName: string): Promise<number> {
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

    async executeQuery(
        connectionString: string,
        query: string,
        context?: { tableName?: string; limit?: number }
    ): Promise<any[]> {
        const collectionName = context?.tableName;
        if (!collectionName) {
            throw new Error('Collection name is required for MongoDB queries (pass context.tableName)');
        }
        const limit = context?.limit ?? 1000;

        // Parse the query string — supports JSON filter or db.collection.find() syntax
        query = query.trim();

        const findMatch = query.match(/db\.\w+\.find\((.*)\)/);
        const countMatch = query.match(/db\.\w+\.(?:countDocuments|count)\((.*)\)/);
        const aggregateMatch = query.match(/db\.\w+\.aggregate\((.*)\)/);

        let filter: any = {};

        if (findMatch) {
            const filterStr = findMatch[1].trim();
            if (filterStr && filterStr !== '{}') {
                filter = this.parseFilterString(filterStr);
            }
            return this.executeFilterQuery(connectionString, collectionName, filter, limit);
        } else if (countMatch) {
            const filterStr = countMatch[1].trim();
            if (filterStr && filterStr !== '{}') {
                filter = this.parseFilterString(filterStr);
            }
            const count = await this.getRowCount(connectionString, collectionName);
            return [{ count }];
        } else if (aggregateMatch) {
            throw new Error('Aggregate queries are not yet supported. Use find() queries.');
        } else {
            // Try to parse as a plain filter object
            if (query === '' || query === '{}') {
                filter = {};
            } else {
                filter = this.parseFilterString(query);
            }
            return this.executeFilterQuery(connectionString, collectionName, filter, limit);
        }
    }

    private parseFilterString(filterStr: string): any {
        // Try JSON first, then eval as JS object literal
        try {
            return JSON.parse(filterStr);
        } catch {
            try {
                return eval('(' + filterStr + ')');
            } catch {
                throw new Error(
                    'Invalid query format. Use MongoDB find() syntax: db.collection.find({field: "value"}) or JSON filter: {"field": "value"}'
                );
            }
        }
    }

    private async executeFilterQuery(
        connectionString: string,
        collectionName: string,
        filter: any,
        limit: number
    ): Promise<any[]> {
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

    async updateRecord(
        connectionString: string,
        collectionName: string,
        filter: Record<string, any>,
        updates: Record<string, any>
    ): Promise<UpdateResult> {
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

            if (!updates || Object.keys(updates).length === 0) {
                throw new Error('No fields to update');
            }

            const collection = db.collection(collectionName);
            
            // Use $set operator to update specific fields
            const updateOperation = { $set: updates };
            
            logger.info(`Updating document in ${collectionName}`, { filter, update: updateOperation });
            
            const result = await collection.updateOne(filter, updateOperation);
            
            logger.info(`Modified ${result.modifiedCount} document(s) in ${collectionName}`);
            
            return {
                success: true,
                affectedCount: result.modifiedCount
            };
        } catch (error) {
            logger.error(`Failed to update document in ${collectionName}`, error);
            throw error;
        } finally {
            await connection.close();
        }
    }

    async getRecordIdentifier(
        _connectionPath: string,
        _tableName: string,
        rowData: Record<string, any>
    ): Promise<Record<string, any>> {
        if (!rowData._id) {
            throw new Error('MongoDB document must have _id field');
        }
        return { _id: rowData._id };
    }

    // Override exportToCSV to flatten nested objects before writing
    async exportToCSV(
        connectionString: string,
        collectionName: string,
        outputPath: string,
        data?: any[]
    ): Promise<string> {
        const exportData = data ?? await this.getTableData(connectionString, collectionName);

        if (exportData.length === 0) {
            throw new Error('No data to export');
        }

        // Flatten nested objects and arrays for CSV
        const flattenedData = exportData.map(doc => this.flattenObject(doc));

        // Get all unique keys from all documents
        const allKeys = new Set<string>();
        flattenedData.forEach(doc => {
            Object.keys(doc).forEach(key => allKeys.add(key));
        });

        const headers = Array.from(allKeys);
        await BaseDatabaseProvider.writeCSVFile(outputPath, headers, flattenedData);
        logger.info(`Exported ${exportData.length} documents from ${collectionName} to ${outputPath}`);
        return outputPath;
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
