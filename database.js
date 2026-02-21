// ARQUIVO: database.js

const { MongoClient } = require('mongodb');

let db;

const initDb = async () => {
    if (db) return db;
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    db = client.db('telegram_bot_db');
    console.log('Successfully connected to MongoDB.');
    return db;
};

const getUser = async (chatId) => {
    const usersCollection = db.collection('users');
    let user = await usersCollection.findOne({ chat_id: chatId });
    if (!user) {
        const newUser = { chat_id: chatId, wallets: [], plan: 'free' };
        await usersCollection.insertOne(newUser);
        return newUser;
    }
    return user;
};

const addUserWallet = async (chatId, walletName, walletAddress) => {
    const usersCollection = db.collection('users');
    const existingWallet = await usersCollection.findOne({ 'wallets.address': walletAddress });
    if (existingWallet) {
        throw new Error("Wallet address is already monitored by someone.");
    }
    const newWallet = { name: walletName, address: walletAddress, lastCheckedBlock: '0', watchedContracts: [] };
    await usersCollection.updateOne({ chat_id: chatId }, { $push: { wallets: newWallet } });
};

const removeUserWallet = async (chatId, walletName) => {
    const usersCollection = db.collection('users');
    await usersCollection.updateOne({ chat_id: chatId }, { $pull: { wallets: { name: walletName } } });
};

const updateWalletName = async (chatId, oldName, newName) => {
    const usersCollection = db.collection('users');
    await usersCollection.updateOne(
        { chat_id: chatId, 'wallets.name': oldName },
        { $set: { 'wallets.$.name': newName } }
    );
};

const updateLastCheckedBlock = async (walletAddress, blockNumber) => {
    const usersCollection = db.collection('users');
    await usersCollection.updateOne(
        { 'wallets.address': walletAddress },
        { $set: { 'wallets.$.lastCheckedBlock': blockNumber } }
    );
};

const getAllWallets = async () => {
    const usersCollection = db.collection('users');
    const users = await usersCollection.find({}).toArray();
    let allWallets = [];
    users.forEach(user => {
        user.wallets.forEach(wallet => {
            allWallets.push({ ...wallet, chat_id: user.chat_id });
        });
    });
    return allWallets;
};

const updateUserPlan = async (chatId, newPlan) => {
    const usersCollection = db.collection('users');
    await usersCollection.updateOne({ chat_id: chatId }, { $set: { plan: newPlan } });
};

const addWatchedContract = async (chatId, walletName, contractAddress, label) => {
    const usersCollection = db.collection('users');
    const newContract = { address: contractAddress, label: label };
    await usersCollection.updateOne(
        { chat_id: chatId, "wallets.name": walletName },
        { $push: { "wallets.$.watchedContracts": newContract } }
    );
};

const removeWatchedContract = async (chatId, walletName, contractAddress) => {
    const usersCollection = db.collection('users');
    await usersCollection.updateOne(
        { chat_id: chatId, "wallets.name": walletName },
        { $pull: { "wallets.$.watchedContracts": { address: contractAddress } } }
    );
};


module.exports = {
    initDb, getUser, addUserWallet, removeUserWallet, getAllWallets,
    updateLastCheckedBlock, updateWalletName, updateUserPlan,
    addWatchedContract, removeWatchedContract
};