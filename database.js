// =================================================================
// ARQUIVO: database.js (VERSÃO FINAL COM MONGOOSE)
// =================================================================

const mongoose = require('mongoose');

// Função para conectar ao banco de dados
const connectDb = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Successfully connected to MongoDB via Mongoose.');
    } catch (error) {
        console.error('Error connecting to MongoDB:', error);
        process.exit(1);
    }
};

// Sub-schema para cada carteira
const WalletSchema = new mongoose.Schema({
    name: { type: String, required: true },
    address: { type: String, required: true },
    lastCheckedBlock: { type: String, default: '0' },
}, { _id: false });

// Schema principal do usuário
const UserSchema = new mongoose.Schema({
    telegramId: { type: Number, required: true, unique: true, index: true },
    wallets: [WalletSchema],
    plan: { type: String, default: 'free', required: true },
    subscription: {
        provider: { type: String },
        customerId: { type: String },
        status: { type: String, default: 'inactive' }
    }
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);

module.exports = { connectDb, User };