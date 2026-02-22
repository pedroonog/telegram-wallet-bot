// =================================================================
// ARQUIVO: index.js (VERSÃO FINAL COM PREÇOS NOS BOTÕES)
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

// =========================================================
// ||     ATUALIZE AQUI COM SEUS IDs DE PREÇO DO STRIPE   ||
// =========================================================
const PLANS = {
  free: { name: 'Free Plan', limit: 3, priceUSD: 0 },
  basic: { name: 'Basic Plan', priceStripeId: 'price_SEU_ID_BASICO', limit: 10, priceUSD: 5.00 },
  intermediate: { name: 'Intermediate Plan', priceStripeId: 'price_SEU_ID_INTERMEDIARIO', limit: 25, priceUSD: 12.00 },
  premium: { name: 'Premium Plan', priceStripeId: 'price_SEU_ID_PREMIUM', limit: 50, priceUSD: 19.00 },
};

// --- LÓGICA SEPARADA PARA REUSO ---

const showPlans = (ctx) => {
    return ctx.replyWithHTML('<b>Choose your subscription plan:</b>', Markup.inlineKeyboard([
        [Markup.button.callback('View Monthly Subscriptions 💳', 'view_subscriptions')]
    ]));
};

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
        return ctx.reply('Welcome! Use the menu to manage wallets or /plans to upgrade.', Markup.keyboard([['📋 My Wallets', '�� Plans'], ['➕ Add Wallet', 'ℹ️ Help']]).resize());
    });
    
    bot.hears('💎 Plans', showPlans);
    bot.hears('📋 My Wallets', showWallets);
    
    bot.hears('ℹ️ Help', (ctx) => ctx.replyWithMarkdown(
        `*Commands Guide*:\n\n` +
        `*/mywallets* - Show your monitored wallets.\n` +
        `*/addwallet <name> <address>* - Add a new wallet to monitor.\n` +
        `*/plans* - View and manage subscription plans.`
    ));
    bot.hears('➕ Add Wallet', (ctx) => ctx.reply('Use the format:\n`/addwallet <name> <address>`', { parse_mode: 'Markdown' }));

    bot.command('plans', showPlans);
    bot.command('mywallets', showWallets);

    bot.command('addwallet', async (ctx) => {
        // ... (código do addwallet sem alterações)
    });

    // =========================================================
    // ||        AQUI OS BOTÕES MOSTRAM O PREÇO CORRETO       ||
    // =========================================================
    bot.action('view_subscriptions', (ctx) => {
        const buttons = Object.entries(PLANS)
            .filter(([key]) => key !== 'free')
            .map(([key, { name, priceUSD }]) => {
                const priceText = `$${priceUSD.toFixed(2)}/month`;
                return [Markup.button.callback(`${name} - ${priceText}`, `pay_stripe:${key}`)]
            });
        
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
        if (!plan || !plan.priceStripeId) {
            return ctx.answerCbQuery('Plan not found or not configured!');
        }

        try {
            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [{ price: plan.priceStripeId, quantity: 1 }],
                mode: 'subscription',
                success_url: `https://t.me/${ctx.botInfo.username}?start=payment_success`,
                cancel_url: `https://t.me/${ctx.botInfo.username}?start=payment_canceled`,
                client_reference_id: ctx.chat.id.toString(),
                metadata: { plan: planKey }
            });

            return ctx.reply(`To complete your purchase for the ${plan.name}, please use the following link:`, Markup.inlineKeyboard([
                [Markup.button.url('Pay Now', session.url)]
            ]));
        } catch (error) {
            console.error("Stripe session creation error:", error);
            return ctx.reply("Sorry, there was an error connecting to the payment service. Please try again later.");
        }
    });
    
    const checkTransactions = async () => {
        // ... (código do checkTransactions sem alterações)
    };
    setInterval(checkTransactions, 30000);
    console.log('🔁 Transaction monitoring loop started.');

    app.use(express.raw({ type: 'application/json' }));

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

            if (userId && planKey && PLANS[planKey]) {
                await User.findOneAndUpdate(
                    { telegramId: parseInt(userId) },
                    { $set: { plan: planKey, 'subscription.status': 'active', 'subscription.provider': 'stripe' } },
                    { returnDocument: 'after' }
                );
                await bot.telegram.sendMessage(userId, `✅ Payment confirmed! Your plan is now ${PLANS[planKey].name}.`);
            }
        }
        res.status(200).send();
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

// Ocultando funções longas e inalteradas para clareza
main.toString = () => {
    // ...
    return `
    main() {
        //... addwallet implementation ...
        //... checkTransactions implementation ...
    }
    `;
};

main();