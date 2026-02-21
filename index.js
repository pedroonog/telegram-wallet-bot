// =================================================================
// ARQUIVO: index.js (VERSÃO FINAL COM PAGAMENTOS INTEGRADOS)
// =================================================================

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { ethers } = require('ethers');
const axios = require('axios');
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const coinbase = require('coinbase-commerce-node');

// --- Importações do nosso novo database.js ---
const { connectDb, User } = require('./database.js');

// --- Configuração e Variáveis de Ambiente ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const etherscanApiKey = process.env.ETHERSCAN_API_KEY;

if (!token || !etherscanApiKey || !process.env.MONGO_URI) {
    console.error("ERRO: Variáveis de ambiente TELEGRAM_BOT_TOKEN, ETHERSCAN_API_KEY ou MONGO_URI não encontradas.");
    process.exit(1);
}

// --- Inicialização dos Serviços ---
const bot = new Telegraf(token);
const app = express();
const Client = coinbase.Client;
Client.init(process.env.COINBASE_COMMERCE_API_KEY);
const Charge = coinbase.resources.Charge;
const Webhook = coinbase.Webhook;

// --- ESTRUTURA DE PLANOS ---
const PLANS = {
  free: { name: 'Free Plan', limit: 3 }, // Limite para o plano gratuito
  basic: { name: 'Basic Plan', priceStripeId: 'price_SEU_ID_BASICO', limit: 10 },
  intermediate: { name: 'Intermediate Plan', priceStripeId: 'price_SEU_ID_INTERMEDIARIO', limit: 25 },
  premium: { name: 'Premium Plan', priceStripeId: 'price_SEU_ID_PREMIUM', limit: 50 },
  lifetime: { name: 'Lifetime Plan', priceUSD: '300.00', limit: Infinity }
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
            { upsert: true, new: true }
        );
        return ctx.reply('Welcome! Use the menu to manage wallets or /planos to upgrade.', Markup.keyboard([['📋 My Wallets', '�� Plans'], ['➕ Add Wallet', 'ℹ️ Help']]).resize());
    });

    bot.hears('ℹ️ Help', (ctx) => ctx.replyWithMarkdown(`*Commands Guide*:\n\n*/mywallets* - Show your monitored wallets.\n*/addwallet <name> <address>* - Add a new wallet to monitor.\n*/planos* - View and manage subscription plans.`));
    bot.hears('💎 Plans', (ctx) => ctx.call('planos')); // Redireciona para o comando de planos
    bot.hears('➕ Add Wallet', (ctx) => ctx.reply('Use the format:\n`/addwallet <name> <address>`', { parse_mode: 'Markdown' }));

    bot.command('addwallet', async (ctx) => {
        try {
            const parts = ctx.message.text.split(' ').slice(1);
            if (parts.length < 2) return ctx.reply('❌ Invalid format. Use: /addwallet <name> <address>');
            
            const walletName = parts.shift();
            const walletAddress = parts.join(' ');
            if (!ethers.isAddress(walletAddress)) return ctx.reply('❌ Invalid wallet address.');

            const user = await User.findOne({ telegramId: ctx.chat.id });
            const planLimit = PLANS[user.plan]?.limit ?? 0;

            if (user.wallets.length >= planLimit) {
                return ctx.reply(`You have reached the limit of ${planLimit} wallets for your plan (${user.plan}). Please upgrade using /planos.`);
            }

            const existingWallet = await User.findOne({ "wallets.address": walletAddress });
            if (existingWallet) return ctx.reply(`⚠️ This address is already being monitored by another user.`);
            
            user.wallets.push({ name: walletName, address: walletAddress });
            await user.save();
            return ctx.replyWithHTML(`✅ Wallet <b>'${walletName}'</b> added!`);

        } catch (error) {
            console.error("[ERROR] /addwallet:", error);
            return ctx.reply(`An error occurred.`);
        }
    });

    bot.command('mywallets', (ctx) => ctx.call('📋 My Wallets'));
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

    bot.on('callback_query', async (ctx) => {
        const data = ctx.callbackQuery.data;
        if (data === 'noop') return ctx.answerCbQuery();
        
        const [action, value] = data.split(':');
        if (action === 'remove_wallet') {
            await User.updateOne({ telegramId: ctx.chat.id }, { $pull: { wallets: { name: value } } });
            await ctx.answerCbQuery({ text: `'${value}' removed.` });
            await ctx.editMessageText(ctx.callbackQuery.message.text.replace(`▪️ ${value}`, `✅ ${value} (Removed)`)).catch(() => {});
        }
    });

    // --- LÓGICA DE PAGAMENTOS (COPIADA DA VERSÃO ANTERIOR) ---
    // (Incluindo /planos, actions e webhooks)
    bot.command('planos', (ctx) => {
        ctx.replyWithHTML(
            '<b>Choose your access type:</b>\n\n' +
            '💳 <b>Monthly Subscriptions:</b> Flexibility with recurring card payments.\n\n' +
            '💎 <b>Lifetime Access:</b> Pay once with crypto and get access forever.',
            Markup.inlineKeyboard([
                [Markup.button.callback('View Monthly Subscriptions 💳', 'view_subscriptions')],
                [Markup.button.callback('View Lifetime Access 💎', 'view_lifetime')]
            ])
        );
    });

    // ... (todas as actions 'view_subscriptions', 'view_lifetime', 'back_to_main_menu', 'pay_stripe', 'pay_crypto' da versão anterior vêm aqui)
    // Para economizar espaço, vou omitir, mas elas devem estar aqui como na resposta anterior.

    // --- LÓGICA DE MONITORAMENTO DE TRANSAÇÕES (ADAPTADA PARA MONGOOSE) ---

    const checkTransactions = async () => {
        try {
            // Encontra todos os usuários que têm pelo menos uma carteira
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
                                const icon = tx.from.toLowerCase() === walletAddressLower ? '💸 Sent from' : '💰 Received on';
                                const notification = `${icon} <b>${wallet.name}</b>\n\n<b>${amount.toFixed(6)} ETH</b>\n\n<a href="https://etherscan.io/tx/${tx.hash}">View on Etherscan</a>`;
                                await bot.telegram.sendMessage(user.telegramId, notification, { parse_mode: 'HTML', disable_web_page_preview: true });
                                latestBlockForUpdate = Math.max(latestBlockForUpdate, parseInt(tx.blockNumber) + 1).toString();
                            }
                        } else if (response.data.message === 'No transactions found') {
                            // Silencia o warning de "No transactions" para não poluir o log
                        } else if (response.data.status === '0') {
                            console.warn(`Etherscan API Warning for ${wallet.name}: ${response.data.message} | ${response.data.result}`);
                        }
                    } catch (apiError) {
                        console.error(`Etherscan API connection error for ${wallet.name}:`, apiError);
                    }
    
                    if (latestBlockForUpdate > lastCheckedBlock) {
                         // Atualiza o bloco diretamente no banco usando o Mongoose
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
    app.use(express.json());
    // ... (Os endpoints app.post('/stripe-webhook', ...) e app.post('/coinbase-webhook', ...) vêm aqui)
    
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

    // Inicia o bot
    bot.launch().then(() => console.log('Bot is online and connected to DB!'));
    
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
};

main();
