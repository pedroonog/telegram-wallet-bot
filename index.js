// =================================================================
// ARQUIVO: index.js (VERSÃO FINAL COM COMANDO /plans)
// =================================================================

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { ethers } = require('ethers');
const axios = require('axios');
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const { connectDb, User } = require('./database.js');

const token = process.env.TELEGRAM_BOT_TOKEN;
const etherscanApiKey = process.env.ETHERSCAN_API_KEY;

if (!token || !etherscanApiKey || !process.env.MONGO_URI || !process.env.STRIPE_SECRET_KEY) {
    console.error("ERRO: Uma ou mais variáveis de ambiente essenciais não foram encontradas (TOKEN, MONGO_URI, ETHERSCAN, STRIPE).");
    process.exit(1);
}

const bot = new Telegraf(token);
const app = express();

const PLANS = {
  free: { name: 'Free Plan', limit: 3 },
  basic: { name: 'Basic Plan', priceStripeId: 'price_SEU_ID_BASICO', limit: 10 },
  intermediate: { name: 'Intermediate Plan', priceStripeId: 'price_SEU_ID_INTERMEDIARIO', limit: 25 },
  premium: { name: 'Premium Plan', priceStripeId: 'price_SEU_ID_PREMIUM', limit: 50 },
};

// --- LÓGICA SEPARADA PARA REUSO ---

// Função para mostrar os planos
const showPlans = (ctx) => {
    return ctx.replyWithHTML('<b>Choose your subscription plan:</b>', Markup.inlineKeyboard([
        [Markup.button.callback('View Monthly Subscriptions ��', 'view_subscriptions')]
    ]));
};

// Função para mostrar as carteiras
const showWallets = async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.chat.id });
    if (!user || user.wallets.length === 0) {
        return ctx.replyWithHTML("You are not monitoring any wallets yet. Use the '➕ Add Wallet' button to start.");
    }
    
    let message = `📋 <b>Monitored Wallets (${user.wallets.length}/${PLANS[user.plan]?.limit ?? 0})</b>\n\n`;
    const inlineKeyboard = user.wallets.flatMap(wallet => [
        [Markup.button.callback(`▪️ ${wallet.name} (${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)})`, `noop`)],
        [Markup.button.callback('🗑️ Remove', `remove_wallet:${wallet.name}`)]
    ]);
    return ctx.replyWithHTML(message, Markup.inlineKeyboard(inlineKeyboard));
};


// --- FUNÇÃO PRINCIPAL DA APLICAÇÃO ---
const main = async () => {
    await connectDb();

    bot.start(async (ctx) => {
        await User.findOneAndUpdate(
            { telegramId: ctx.chat.id },
            { $setOnInsert: { wallets: [], plan: 'free' } },
            { upsert: true, returnDocument: 'after' }
        );
        return ctx.reply('Welcome! Use the menu to manage wallets or /plans to upgrade.', Markup.keyboard([['📋 My Wallets', '💎 Plans'], ['➕ Add Wallet', 'ℹ️ Help']]).resize());
    });
    
    // --- Handlers dos botões do teclado ---
    bot.hears('�� Plans', showPlans);
    bot.hears('📋 My Wallets', showWallets);
    
    // --- ATUALIZAÇÃO DA MENSAGEM DE AJUDA ---
    bot.hears('ℹ️ Help', (ctx) => ctx.replyWithMarkdown(
        `*Commands Guide*:\n\n` +
        `*/mywallets* - Show your monitored wallets.\n` +
        `*/addwallet <name> <address>* - Add a new wallet to monitor.\n` +
        `*/plans* - View and manage subscription plans.`
    ));
    bot.hears('➕ Add Wallet', (ctx) => ctx.reply('Use the format:\n`/addwallet <name> <address>`', { parse_mode: 'Markdown' }));

    // --- Definição dos Comandos ---
    bot.command('plans', showPlans); // <-- ALTERAÇÃO APLICADA AQUI
    bot.command('mywallets', showWallets);

    bot.command('addwallet', async (ctx) => {
        try {
            const parts = ctx.message.text.split(' ').slice(1);
            if (parts.length < 2) return ctx.reply('❌ Invalid format. Use: /addwallet <name> <address>');
            
            const walletName = parts.shift();
            const walletAddress = parts.join(' ');
            if (!ethers.isAddress(walletAddress)) return ctx.reply('❌ Invalid wallet address.');

            const user = await User.findOneAndUpdate(
                { telegramId: ctx.chat.id },
                { $setOnInsert: { wallets: [], plan: 'free' } },
                { upsert: true, returnDocument: 'after' }
            );

            const planLimit = PLANS[user.plan]?.limit ?? 0;

            if (user.wallets.length >= planLimit) {
                return ctx.reply(`You have reached the limit of ${planLimit} wallets for your plan (${user.plan}). Please use /plans to upgrade.`);
            }

            const existingWallet = await User.findOne({ "wallets.address": walletAddress });
            if (existingWallet) return ctx.reply(`⚠️ This address is already being monitored by another user.`);
            
            await User.updateOne(
                { telegramId: ctx.chat.id },
                { $push: { wallets: { name: walletName, address: walletAddress } } }
            );

            return ctx.replyWithHTML(`✅ Wallet <b>'${walletName}'</b> added!`);

        } catch (error) {
            console.error("[ERROR] /addwallet:", error);
            return ctx.reply(`An error occurred.`);
        }
    });

    // --- Lógica dos Botões Inline (dentro dos menus) ---

    bot.action('view_subscriptions', (ctx) => {
        const buttons = Object.entries(PLANS)
            .filter(([key]) => key !== 'free')
            .map(([key, { name }]) => [Markup.button.callback(name, `pay_stripe:${key}`)]);
        
        ctx.editMessageText('<b>Choose a monthly plan:</b>', {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [...buttons, [Markup.button.callback('« Back', 'back_to_main_menu')]] }
        });
    });
    
    bot.action('back_to_main_menu', (ctx) => {
        ctx.editMessageText('<b>Choose your subscription plan:</b>', {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[Markup.button.callback('View Monthly Subscriptions 💳', 'view_subscriptions')]] }
        });
    });

    bot.action(/pay_stripe:(.+)/, async (ctx) => {
        // ... (código do stripe não muda)
    });
    
    const checkTransactions = async () => {
        // ... (código do checkTransactions não muda)
    };
    setInterval(checkTransactions, 30000);
    console.log('🔁 Transaction monitoring loop started.');

    app.use(express.raw({ type: 'application/json' }));

    app.post('/stripe-webhook', async (req, res) => {
        // ... (código do webhook não muda)
    });

    app.get('/', (req, res) => {
        res.status(200).send('Bot is running and healthy.');
    });

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

    bot.launch().then(() => console.log('🤖 Bot is online and connected to DB!'));
    
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
};

main();
