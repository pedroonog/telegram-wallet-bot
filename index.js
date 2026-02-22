require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const { ethers } = require('ethers');
const Stripe = require('stripe');

// --- CONFIGURAÇÃO ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const stripe = new Stripe(STRIPE_SECRET_KEY);
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// --- DEFINIÇÃO DOS PLANOS ---
// Lembre-se de usar os limites corretos que você definiu
const PLANS = {
    free: { name: 'Free', limit: 1 },
    basic: { name: 'Basic Plan', priceStripeId: 'price_SEU_ID_BASICO', limit: 3, priceUSD: 5.00 },
    intermediate: { name: 'Intermediate Plan', priceStripeId: 'price_SEU_ID_INTERMEDIARIO', limit: 5, priceUSD: 12.00 },
    premium: { name: 'Premium Plan', priceStripeId: 'price_SEU_ID_PREMIUM', limit: 10, priceUSD: 19.00 },
};

// --- BANCO DE DADOS (MONGOOSE) ---
const UserSchema = new mongoose.Schema({
    telegramId: { type: Number, required: true, unique: true, index: true },
    firstName: { type: String, required: true },
    plan: { type: String, required: true, default: 'free' },
    wallets: [{ type: String }],
    stripeCustomerId: { type: String, unique: true, sparse: true },
});
const User = mongoose.model('User', UserSchema);

mongoose.connect(MONGO_URI)
    .then(() => console.log('🤖 Bot conectado com sucesso ao MongoDB!'))
    .catch(err => console.error('❌ Erro ao conectar ao MongoDB:', err));

// --- LÓGICA DO BOT (TELEGRAF) ---

const getOrCreateUser = async (ctx) => {
    const telegramId = ctx.from.id;
    let user = await User.findOne({ telegramId });

    if (!user) {
        user = new User({
            telegramId,
            firstName: ctx.from.first_name, // O nome é pego aqui
            plan: 'free',
        });
        await user.save();
        console.log(`✨ Novo usuário criado: ${user.firstName} (${user.telegramId})`);
    }
    return user;
};

const mainKeyboard = Markup.keyboard([
    ['➕ Add Wallet', '📋 My Wallets'],
    ['🌟 Plans', '❓ Help']
]).resize();

bot.start(async (ctx) => {
    await getOrCreateUser(ctx);
    ctx.reply(`Welcome, ${ctx.from.first_name}!\n\nI am your Ethereum Wallet Monitoring Bot.`, mainKeyboard);
});

bot.hears('❓ Help', (ctx) => {
    const helpMessage = `
*How to use me:*

*1. Add a Wallet:*
- Click the "➕ Add Wallet" button and send me the address.
- Or, you can just paste a valid Ethereum address directly into the chat at any time!

*2. View Wallets:*
- Click "📋 My Wallets" to see all wallets you are monitoring and your current limit.

*3. Upgrade Plan:*
- Click "🌟 Plans" to see available subscriptions and increase your wallet limit.
    `;
    ctx.replyWithMarkdown(helpMessage);
});

bot.hears('�� Plans', (ctx) => {
    // ... (código dos planos permanece o mesmo)
});

bot.action(/subscribe_/, async (ctx) => {
    // ... (código das ações de plano permanece o mesmo)
});

bot.hears('📋 My Wallets', async (ctx) => {
    const user = await getOrCreateUser(ctx);
    const planDetails = PLANS[user.plan] || PLANS.free;
    
    let message = `📋 *Your Monitored Wallets (${user.wallets.length}/${planDetails.limit})*\n\n`;
    if (user.wallets.length === 0) {
        message += 'You are not monitoring any wallets yet. To add one, just send me the address!';
    } else {
        user.wallets.forEach((wallet, index) => {
            message += `${index + 1}. \`${wallet}\`\n`;
        });
    }
    ctx.replyWithMarkdown(message);
});

// --- FLUXO DE ADICIONAR CARTEIRA (REFINADO) ---

// 1. O botão apenas dá a instrução.
bot.hears('➕ Add Wallet', (ctx) => {
    ctx.reply('To add a new wallet, just send me the address (e.g., 0x...).');
});

// 2. O handler de texto agora é o cérebro. Ele lida com qualquer mensagem de texto que não seja um comando conhecido.
bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();
    
    // Ignora se for um comando que já tem um 'hears' (para evitar dupla resposta)
    if (['/start', '➕ Add Wallet', '📋 My Wallets', '🌟 Plans', '❓ Help'].includes(text)) {
        return;
    }

    // A MÁGICA ACONTECE AQUI: Verifica se o texto é um endereço de carteira válido.
    if (ethers.isAddress(text)) {
        const address = text; // É um endereço válido, vamos processá-lo.
        
        try {
            const user = await getOrCreateUser(ctx);
            const planDetails = PLANS[user.plan] || PLANS.free;
            
            if (user.wallets.length >= planDetails.limit) {
                return ctx.reply('You have reached your wallet limit. Please click "�� Plans" to upgrade.');
            }

            if (user.wallets.includes(address)) {
                return ctx.reply('This wallet is already being monitored.');
            }
            
            user.wallets.push(address);
            await user.save();

            console.log(`➕ Carteira ${address} adicionada para o usuário ${ctx.from.id}`);
            ctx.reply(`✅ Wallet \`${address}\` added successfully!`, { parse_mode: 'Markdown' });

        } catch (error) {
            console.error(`❌ Erro ao adicionar carteira para o usuário ${ctx.from.id}:`, error);
            ctx.reply('An unexpected error occurred. Please try again.');
        }

    } else {
        // Se o texto não for um endereço nem um comando, envie uma ajuda gentil.
        ctx.reply("I'm not sure what you mean. If you want to add a wallet, please send a valid address (0x...). Otherwise, you can use the menu below.", mainKeyboard);
    }
});


// --- LÓGICA DO WEBHOOK (STRIPE) e INICIALIZAÇÃO DO SERVIDOR ---
// ... (Todo o resto do código a partir daqui permanece exatamente o mesmo)
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    // ...
});

app.get('/', (req, res) => {
    res.send('Bot is running and healthy.');
});

app.listen(port, () => {
    console.log(`🚀 Servidor rodando na porta ${port}`);
});

bot.launch()
    .then(() => console.log('�� Bot iniciado com sucesso!'))
    .catch(err => console.error('❌ Erro ao iniciar o bot:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
