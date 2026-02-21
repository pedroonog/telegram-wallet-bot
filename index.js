// =================================================================
// ARQUIVO DE DIAGNÓSTICO FINAL - VERSÃO 1.3
// DESCRIÇÃO: Captura o objeto de erro completo para depuração.
// =================================================================

require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const { ethers } = require('ethers');
const axios = require('axios');
const db = require('./database.js');

const token = process.env.TELEGRAM_BOT_TOKEN;
const etherscanApiKey = process.env.ETHERSCAN_API_KEY;

const ETHERSCAN_API_BASE_URL = 'https://api.etherscan.io/v2/api';

if (!token || !etherscanApiKey) {
    console.error("ERRO: Variáveis de ambiente TELEGRAM_BOT_TOKEN ou ETHERSCAN_API_KEY não encontradas.");
    process.exit(1);
}

const bot = new Telegraf(token);

db.initDb().then(() => {
    console.log("Successfully connected to MongoDB.");
    bot.launch().then(() => console.log('Bot is online and listening for messages...'));
}).catch(err => {
    console.error("FALHA AO INICIAR O BANCO DE DADOS:", err.message);
    process.exit(1);
});

// --- Comandos e Interações do Telegram ---
// (Toda a lógica dos botões e comandos permanece a mesma da versão anterior)

bot.start(async (ctx) => {
    await db.getUser(ctx.chat.id);
    return ctx.reply('Bot is running and stable. Use the menu to manage wallets.', Markup.keyboard([['📋 My Wallets', '🔬 Watch Contracts'], ['➕ Add Wallet', 'ℹ️ Help']]).resize());
});
bot.hears('ℹ️ Help', (ctx) => ctx.replyWithMarkdown(`*Commands Guide*:\n\n*/mywallets*\nShow wallets.\n\n*/addwallet <name> <address>*\nAdd a wallet.`));
bot.hears('➕ Add Wallet', (ctx) => ctx.reply('Use the format:\n`/addwallet <name> <address>`', { parse_mode: 'Markdown' }));
bot.command('addwallet', async (ctx) => {
    const parts = ctx.message.text.split(' ').slice(1);
    if (parts.length < 2) return ctx.reply('❌ Invalid format.');
    const walletName = parts.shift();
    const walletAddress = parts.join(' ');
    if (!ethers.isAddress(walletAddress)) return ctx.reply('❌ Invalid address.');
    try {
        await db.addUserWallet(ctx.chat.id, walletName, walletAddress);
        return ctx.replyWithHTML(`✅ Wallet <b>'${walletName}'</b> added!`);
    } catch (error) {
        return ctx.reply(`⚠️ Address already monitored.`);
    }
});
bot.hears('📋 My Wallets', async (ctx) => {
    try {
        const user = await db.getUser(ctx.chat.id);
        let message = `📋 <b>Monitored Wallets</b>\n\n`;
        if (user.wallets.length === 0) return ctx.replyWithHTML(message + "You are not monitoring any wallets yet.");
        const inlineKeyboard = user.wallets.flatMap(wallet => [[Markup.button.callback(`▪️ ${wallet.name}`, `noop`)], [Markup.button.callback('��️ Remove', `remove_wallet:${wallet.name}`)]]);
        return ctx.replyWithHTML(message, Markup.inlineKeyboard(inlineKeyboard));
    } catch (error) {
        console.error("[ERROR] An error occurred while fetching wallets:", error);
        return ctx.reply("Sorry, an error occurred. Please check the console.");
    }
});
bot.hears('🔬 Watch Contracts', (ctx) => ctx.reply('This feature is coming soon!'));
bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [action, value1] = data.split(':');
    if (action === 'noop') return ctx.answerCbQuery();
    if (action === 'remove_wallet') {
        await db.removeUserWallet(ctx.chat.id, value1);
        await ctx.answerCbQuery({ text: `'${value1}' removed.` });
        await ctx.editMessageText(ctx.callbackQuery.message.text + `\n\n✅ <i>Wallet '${value1}' removed.</i>`, { parse_mode: 'HTML' }).catch(() => {});
    }
});


// --- Lógica de Monitoramento de Transações ---

const checkTransactions = async () => {
    try {
        const allWallets = await db.getAllWallets();
        if (allWallets.length === 0) return;

        for (const wallet of allWallets) {
            const lastCheckedBlock = wallet.lastCheckedBlock || '0';
            let latestBlockForUpdate = lastCheckedBlock;
            const walletAddressLower = wallet.address.toLowerCase();
            const apiUrl = `${ETHERSCAN_API_BASE_URL}?chainid=1&module=account&action=txlist&address=${wallet.address}&startblock=${lastCheckedBlock}&endblock=99999999&sort=asc&apikey=${etherscanApiKey}`;

            try {
                const response = await axios.get(apiUrl);
                if (response.data.status === '1' && Array.isArray(response.data.result)) {
                    // Lógica de sucesso para processar transações...
                     for (const tx of response.data.result) {
                        if (tx.value === '0') {
                            latestBlockForUpdate = Math.max(latestBlockForUpdate, parseInt(tx.blockNumber) + 1).toString();
                            continue;
                        }
                        const amount = parseFloat(ethers.formatEther(tx.value));
                        const icon = tx.from.toLowerCase() === walletAddressLower ? '💸 Sent from' : '💰 Received on';
                        const notification = `${icon} <b>${wallet.name}</b>\n\n<b>${amount.toFixed(6)} ETH</b>\n\n<a href="https://etherscan.io/tx/${tx.hash}">View on Etherscan</a>`;
                        await bot.telegram.sendMessage(wallet.chat_id, notification, { parse_mode: 'HTML', disable_web_page_preview: true });
                        latestBlockForUpdate = Math.max(latestBlockForUpdate, parseInt(tx.blockNumber) + 1).toString();
                    }
                } else if (response.data.status === '0') {
                    console.warn(`Etherscan API Warning for ${wallet.name}: ${response.data.message} | ${response.data.result}`);
                }
            } catch (apiError) {
                // +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
                // ALTERAÇÃO DE DIAGNÓSTICO APLICADA AQUI
                // Trocamos apiError.message por apiError para ver o erro completo.
                console.error(`Etherscan API connection error for ${wallet.name}:`, apiError);
                // +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
            }

            if (latestBlockForUpdate > lastCheckedBlock) {
                 await db.updateLastCheckedBlock(wallet.address, latestBlockForUpdate);
            }
        }
    } catch (loopError) {
        console.error("Error in main checkTransactions loop:", loopError);
    }
};

setInterval(checkTransactions, 30000);
console.log('🔁 Transaction monitoring loop started.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
