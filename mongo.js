const { MongoClient } = require('mongodb');

const uri = "mongodb://divAdmin:Divinfosys%40789@35.154.230.134:27017/admin";

if (!uri) {
    throw new Error('MONGODB_URI is missing');
}

const client = new MongoClient(uri, {
    maxPoolSize: 10
});

let connectPromise;

function connectMongo() {
    if (!connectPromise) {
        connectPromise = client.connect();
    }

    return connectPromise;
}

async function getMongoDb(cmpid) {
    if (!cmpid) {
        throw new Error('cmpid is required to select MongoDB database');
    }

    await connectMongo();

    return client.db(cmpid);
}

// ---------------- FIND ----------------

async function executeMongoFind(
    { collection, cmpid },
    filter = {},
    projection = {},
    options = {}
) {
    if (!collection) {
        throw new Error('collection is required');
    }

    const db = await getMongoDb(cmpid);

    const cursor = db.collection(collection).find(filter, {
        projection,
        ...options
    });

    return cursor.toArray();
}

// ---------------- COUNT -----------------

async function executeMongoCount(
    { collection, cmpid },
    filter = {}
) {
    if (!collection) {
        throw new Error('collection is required');
    }

    const db = await getMongoDb(cmpid);

    const count = await db.collection(collection).countDocuments(filter);

    return count;
}

// ---------------- UPDATE ----------------

async function executeMongoUpdate(
    { collection, cmpid },
    filter = {},
    update = {},
    options = {}
) {
    if (!collection) {
        throw new Error('collection is required');
    }

    const db = await getMongoDb(cmpid);

    return await db.collection(collection).updateOne(
        filter,
        update,
        options
    );
}

// ---------------- UPDATE MANY ----------------

async function executeMongoUpdateMany(
    { collection, cmpid },
    filter = {},
    update = {},
    options = {}
) {
    if (!collection) {
        throw new Error('collection is required');
    }

    const db = await getMongoDb(cmpid);

    return await db.collection(collection).updateMany(
        filter,
        update,
        options
    );
}

// ---------------- INSERT ONE ----------------

async function executeMongoInsert(
    { collection, cmpid },
    document
) {
    const db = await getMongoDb(cmpid);

    return await db.collection(collection).insertOne(document);
}

// ---------------- DELETE ONE ----------------

async function executeMongoDelete(
    { collection, cmpid },
    filter = {}
) {
    const db = await getMongoDb(cmpid);

    return await db.collection(collection).deleteOne(filter);
}

// ---------------- CLOSE ----------------

async function closeMongo() {
    await client.close();
    connectPromise = null;
}

module.exports = {
    connectMongo,
    getMongoDb,
    executeMongoFind,
    executeMongoCount,
    executeMongoUpdate,
    executeMongoUpdateMany,
    executeMongoInsert,
    executeMongoDelete,
    closeMongo
};