// =================================================================
// ARQUIVO: index.js (VERSÃO FINAL COM TODAS AS CORREÇÕES)
// =================================================================

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { ethers } = require('ethers');
const axios = require('axios');
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// --- Importações do nosso novo database.js ---
const { connectDb, User } = require('./database.js');

// --- Configuração e Variáveis de Ambiente ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const etherscanApiKey = process.env.ETHERSCAN_API_KEY;

// Verificação de variáveis essenciais
if (!token || !etherscanApiKey || !process.env.MONGO_URI || !process.env.STRIPE_SECRET_KEY) {
    console.error("ERRO: Uma ou mais variáveis de ambiente essenciais não foram encontradas (TOKEN, MONGO_URI, ETHERSCAN, STRIPE).");
    process.exit(1);
}

// --- Inicialização dos Serviços ---
const bot = new Telegraf(token);
const app = express();

// --- ESTRUTURA DE PLANOS ---
const PLANS = {
  free: { name: 'Free Plan', limit: 3 },
  basic: { name: 'Basic Plan', priceStripeId: 'price_SEU_ID_BASICO', limit: 10 },
  intermediate: { name: 'Intermediate Plan', priceStripeId: 'price_SEU_ID_INTERMEDIARIO', limit: 25 },
  premium: { name: 'Premium Plan', priceStripeId: 'price_SEU_ID_PREMIUM', limit: 50 },
};

// --- FUNÇÃO PRINCIPAL DA APLICAÇÃO ---
const main = async () => {
    // 1. Conecta ao Banco de Dados
    await connectDb();

    // --- COMANDOS E INTERAÇÕES DO TELEGRAM ---

    bot.start(async (ctx) => {
        await User.findOneAndUpdate(
            { telegramId: ctx.chat.id },
            { $setOnInsert: { wallets: [], plan: 'free' } },
            { upsert: true, returnDocument: 'after' }
        );
        return ctx.reply('Welcome! Use the menu to manage wallets or /plans to upgrade.', Markup.keyboard([['📋 My Wallets', '💎 Plans'], ['➕ Add Wallet', 'ℹ️ Help']]).resize());
    });

    bot.hears('ℹ️ Help', (ctx) => ctx.replyWithMarkdown(`*Commands Guide*:\n\n*/mywallets* - Show your monitored wallets.\n*/addwallet <name> <address>* - Add a new wallet to monitor.\n*/plans* - View and manage subscription plans.`));
    bot.hears('💎 Plans', (ctx) => bot.handleUpdate({ message: { text: '/plans', chat: { id: ctx.chat.id } } }));
    bot.hears('➕ Add Wallet', (ctx) => ctx.reply('Use the format:\n`/addwallet <name> <address>`', { parse_mode: 'Markdown' }));

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
                return ctx.reply(`You have reached the limit of ${planLimit} wallets for your plan (${user.plan}). Please upgrade using /planos.`);
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

    bot.command('mywallets', (ctx) => bot.handleUpdate({ message: { text: '📋 My Wallets', chat: { id: ctx.chat.id } } }));
    bot.hears('�� My Wallets', async (ctx) => {
        const user = await User.findOne({ telegramId: ctx.chat.id });
        if (!user || user.wallets.length === 0) return ctx.replyWithHTML("You are not monitoring any wallets yet.");
        
        let message = `📋 <b>Monitored Wallets (${user.wallets.length}/${PLANS[user.plan]?.limit ?? 0})</b>\n\n`;
        const inlineKeyboard = user.wallets.flatMap(wallet => [
            [Markup.button.callback(`▪️ ${wallet.name} (${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)})`, `noop`)],
            [Markup.button.callback('🗑️ Remove', `remove_wallet:${wallet.name}`)]
        ]);
        return ctx.replyWithHTML(message, Markup.inlineKeyboard(inlineKeyboard));
    });

    // --- LÓGICA DE PAGAMENTOS ---
    bot.command('plans', (ctx) => {
        ctx.replyWithHTML('<b>Choose your subscription plan:</b>', Markup.inlineKeyboard([
            [Markup.button.callback('View Monthly Subscriptions ��', 'view_subscriptions')]
        ]));
    });

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
        const planKey = ctx.match[1];
        const plan = PLANS[planKey];
        if (!plan) return ctx.answerCbQuery('Plan not found!');

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{ price: plan.priceStripeId, quantity: 1 }],
            mode: 'subscription',
            success_url: `https://t.me/${ctx.botInfo.username}`,
            cancel_url: `https://t.me/${ctx.botInfo.username}`,
            client_reference_id: ctx.chat.id.toString(),
            metadata: { plan: planKey }
        });

        return ctx.reply(`To complete your purchase for the ${plan.name}, please use the following link:`, Markup.inlineKeyboard([
            [Markup.button.url('Pay Now', session.url)]
        ]));
    });

    // --- LÓGICA DE MONITORAMENTO DE TRANSAÇÕES ---
    const checkTransactions = async () => {
        try {
            const usersWithWallets = await User.find({ 'wallets.0': { $exists: true } });
            if (usersWithWallets.length === 0) return;
    
            for (const user of usersWithWallets) {
                for (const wallet of user.wallets) {
                    const lastCheckedBlock = wallet.lastCheckedBlock || '0';
                    let latestBlockForUpdate = lastCheckedBlock;
                    const walletAddressLower = wallet.address.toLowerCase();
                    const apiUrl = `https://api.etherscan.io/api?module=account&action=txlist&address=${wallet.address}&startblock=${lastCheckedBlock}&endblock=99999999&sort=asc&apikey=${etherscanApiKey}`;
    
                    try {
                        const response = await axios.get(apiUrl);
                        if (response.data.status === '1' && Array.isArray(response.data.result)) {
                            for (const tx of response.data.result) {
                                if (parseInt(tx.blockNumber) < parseInt(lastCheckedBlock)) continue;
                                if (tx.value === '0') {
                                    latestBlockForUpdate = Math.max(latestBlockForUpdate, parseInt(tx.blockNumber) + 1).toString();
                                    continue;
                                }
                                const amount = parseFloat(ethers.formatEther(tx.value));
                                const icon = tx.from.toLowerCase() === walletAddressLower ? '📤 Sent from' : '💰 Received on';
                                const notification = `${icon} <b>${wallet.name}</b>\n\n<b>${amount.toFixed(6)} ETH</b>\n\n<a href="https://etherscan.io/tx/${tx.hash}">View on Etherscan</a>`;
                                await bot.telegram.sendMessage(user.telegramId, notification, { parse_mode: 'HTML', disable_web_page_preview: true });
                                latestBlockForUpdate = Math.max(latestBlockForUpdate, parseInt(tx.blockNumber) + 1).toString();
                            }
                        } else if (response.data.message !== 'No transactions found') {
                            console.warn(`Etherscan API Warning for ${wallet.name}: ${response.data.message} | ${response.data.result}`);
                        }
                    } catch (apiError) {
                        console.error(`Etherscan API connection error for ${wallet.name}:`, apiError.message);
                    }
    
                    if (latestBlockForUpdate > lastCheckedBlock) {
                         await User.updateOne(
                            { "wallets.address": wallet.address },
                            { $set: { "wallets.$.lastCheckedBlock": latestBlockForUpdate } }
                         );
                    }
                }
            }
        } catch (loopError) {
            console.error("Error in main checkTransactions loop:", loopError);
        }
    };
    
    setInterval(checkTransactions, 30000);
    console.log('🔁 Transaction monitoring loop started.');

    // --- WEBHOOKS E SERVIDOR WEB ---
    app.use(express.raw({ type: 'application/json' })); // Usar o raw parser para todos os webhooks

    app.post('/stripe-webhook', async (req, res) => {
        const sig = req.headers['stripe-signature'];
        let event;

        try {
            event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
        } catch (err) {
            console.error('⚠️ Stripe webhook signature verification failed.', err.message);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const userId = session.client_reference_id;
            const planKey = session.metadata.plan;

            const user = await User.findOneAndUpdate(
                { telegramId: parseInt(userId) },
                { $set: { plan: planKey, 'subscription.status': 'active', 'subscription.provider': 'stripe' } },
                { returnDocument: 'after' }
            );

            if (user) {
                await bot.telegram.sendMessage(userId, `✅ Payment confirmed! Your plan is now ${PLANS[planKey].name}.`);
            }
        }
        res.status(200).send();
    });

    // Rota para o Health Check do Railway
    app.get('/', (req, res) => {
        res.status(200).send('Bot is running and healthy.');
    });

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`�� Server running on port ${PORT}`));

    // Inicia o bot
    bot.launch().then(() => console.log('🤖 Bot is online and connected to DB!'));
    
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
};

main();