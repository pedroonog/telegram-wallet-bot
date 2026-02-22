require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const { ethers } = require('ethers');
const Stripe = require('stripe');

// --- CONFIGURAÇÃO ---
// As chaves são carregadas das variáveis de ambiente (configuradas no Railway)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Instanciação dos serviços
const stripe = new Stripe(STRIPE_SECRET_KEY);
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// --- DEFINIÇÃO DOS PLANOS ---
// !! IMPORTANTE !! Substitua 'price_...' pelos IDs de API reais dos seus preços no Stripe.
const PLANS = {
    free: { name: 'Free', limit: 1 }, // Limite padrão para novos usuários
    basic: { name: 'Basic Plan', priceStripeId: 'price_SEU_ID_BASICO', limit: 3, priceUSD: 5.00 },
    intermediate: { name: 'Intermediate Plan', priceStripeId: 'price_SEU_ID_INTERMEDIARIO', limit: 5, priceUSD: 12.00 },
    premium: { name: 'Premium Plan', priceStripeId: 'price_SEU_ID_PREMIUM', limit: 10, priceUSD: 19.00 },
};

// --- BANCO DE DADOS (MONGOOSE) ---
// Schema do Usuário
const UserSchema = new mongoose.Schema({
    telegramId: { type: Number, required: true, unique: true, index: true },
    firstName: { type: String, required: true },
    plan: { type: String, required: true, default: 'free' },
    wallets: [{ type: String }],
    stripeCustomerId: { type: String, unique: true, sparse: true },
});

// Modelo do Usuário
const User = mongoose.model('User', UserSchema);

// Conexão com o MongoDB
mongoose.connect(MONGO_URI)
    .then(() => console.log('🤖 Bot conectado com sucesso ao MongoDB!'))
    .catch(err => console.error('❌ Erro ao conectar ao MongoDB:', err));

// --- LÓGICA DO BOT (TELEGRAF) ---

// Armazenamento de estado simples para saber o que o usuário está fazendo
const userState = {};

// Função para obter ou criar um usuário no banco de dados
const getOrCreateUser = async (ctx) => {
    const telegramId = ctx.from.id;
    let user = await User.findOne({ telegramId });

    if (!user) {
        user = new User({
            telegramId,
            firstName: ctx.from.first_name,
            plan: 'free',
        });
        await user.save();
        console.log(`✨ Novo usuário criado: ${user.firstName} (${user.telegramId})`);
    }
    return user;
};

// Menu Principal
const mainKeyboard = Markup.keyboard([
    ['➕ Add Wallet', '📋 My Wallets'],
    ['🌟 Plans', '❓ Help']
]).resize();

// Comando /start
bot.start(async (ctx) => {
    await getOrCreateUser(ctx);
    ctx.reply(
        `Welcome, ${ctx.from.first_name}!\n\nI am your Ethereum Wallet Monitoring Bot.\n\nUse the menu below to manage your wallets.`,
        mainKeyboard
    );
});

// Botão "Help"
bot.hears('❓ Help', (ctx) => {
    ctx.reply('To add a wallet, click "➕ Add Wallet" or simply send me a valid Ethereum address.\n\nTo see your monitored wallets, click "📋 My Wallets".\n\nTo upgrade your plan, click "🌟 Plans".');
});

// Botão "Plans"
bot.hears('🌟 Plans', (ctx) => {
    const planMessage = `
*Our Subscription Plans*

*Free Plan:*
- Monitor up to ${PLANS.free.limit} wallet.

*Basic Plan ($${PLANS.basic.priceUSD.toFixed(2)}/month):*
- Monitor up to ${PLANS.basic.limit} wallets.

*Intermediate Plan ($${PLANS.intermediate.priceUSD.toFixed(2)}/month):*
- Monitor up to ${PLANS.intermediate.limit} wallets.

*Premium Plan ($${PLANS.premium.priceUSD.toFixed(2)}/month):*
- Monitor up to ${PLANS.premium.limit} wallets.

Select a plan to upgrade.
    `;
    ctx.replyWithMarkdown(planMessage, Markup.inlineKeyboard([
        [Markup.button.callback(`Basic Plan - $${PLANS.basic.priceUSD.toFixed(2)}`, 'subscribe_basic')],
        [Markup.button.callback(`Intermediate Plan - $${PLANS.intermediate.priceUSD.toFixed(2)}`, 'subscribe_intermediate')],
        [Markup.button.callback(`Premium Plan - $${PLANS.premium.priceUSD.toFixed(2)}`, 'subscribe_premium')],
    ]));
});

// Ações dos botões de plano
const planActions = ['subscribe_basic', 'subscribe_intermediate', 'subscribe_premium'];
bot.action(planActions, async (ctx) => {
    try {
        const planKey = ctx.match[0].split('_')[1];
        const plan = PLANS[planKey];

        if (!plan || !plan.priceStripeId) {
            return ctx.answerCbQuery('Error: Plan not configured correctly.', { show_alert: true });
        }

        const user = await getOrCreateUser(ctx);
        let stripeCustomerId = user.stripeCustomerId;

        if (!stripeCustomerId) {
            const customer = await stripe.customers.create({
                email: `${user.telegramId}@telegram.bot`,
                name: user.firstName,
                metadata: { telegramId: user.telegramId },
            });
            stripeCustomerId = customer.id;
            user.stripeCustomerId = stripeCustomerId;
            await user.save();
        }

        const session = await stripe.checkout.sessions.create({
            customer: stripeCustomerId,
            payment_method_types: ['card'],
            line_items: [{
                price: plan.priceStripeId,
                quantity: 1,
            }],
            mode: 'subscription',
            success_url: `https://t.me/${ctx.botInfo.username}`, // Retorna ao bot no sucesso
            cancel_url: `https://t.me/${ctx.botInfo.username}`, // Retorna ao bot no cancelamento
            metadata: {
                telegramId: user.telegramId,
                plan: planKey,
            }
        });
        
        await ctx.reply(`To complete your subscription for the ${plan.name}, please proceed to payment:`, Markup.inlineKeyboard([
            Markup.button.url('💳 Pay Now', session.url)
        ]));
        await ctx.answerCbQuery();

    } catch (error) {
        console.error('❌ Erro ao criar sessão do Stripe:', error);
        await ctx.reply('An error occurred while creating the payment session. Please try again later.');
        await ctx.answerCbQuery('Error processing request.', { show_alert: true });
    }
});


// Botão "My Wallets"
bot.hears('�� My Wallets', async (ctx) => {
    const user = await getOrCreateUser(ctx);
    const planDetails = PLANS[user.plan];
    
    let message = `�� *Your Monitored Wallets (${user.wallets.length}/${planDetails.limit})*\n\n`;
    if (user.wallets.length === 0) {
        message += 'You are not monitoring any wallets yet.';
    } else {
        user.wallets.forEach((wallet, index) => {
            message += `${index + 1}. \`${wallet}\`\n`;
        });
    }
    ctx.replyWithMarkdown(message);
});

// Botão "Add Wallet"
bot.hears('➕ Add Wallet', (ctx) => {
    userState[ctx.from.id] = 'awaiting_wallet';
    ctx.reply('Please send me the Ethereum wallet address you want to monitor.');
});


// Handler para receber o endereço da carteira
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    // Ignora o texto se não for um comando ou se não estiver esperando um endereço
    if (!userState[userId] || userState[userId] !== 'awaiting_wallet') {
        // Se o texto for um endereço válido, o bot pode proativamente se oferecer para adicioná-lo
        if (ethers.isAddress(ctx.message.text.trim())) {
             ctx.reply('Did you want to add this wallet? Click "➕ Add Wallet" first, then send the address.');
        }
        return;
    }

    const address = ctx.message.text.trim();
    
    // Reseta o estado do usuário
    delete userState[userId];

    try {
        if (!ethers.isAddress(address)) {
            return ctx.reply('Invalid wallet address format. Please send a valid Ethereum address.');
        }

        const user = await getOrCreateUser(ctx);
        const planDetails = PLANS[user.plan];
        
        if (user.wallets.length >= planDetails.limit) {
            return ctx.reply('You have reached your wallet limit for the current plan. Please upgrade to add more wallets.');
        }

        if (user.wallets.includes(address)) {
            return ctx.reply('This wallet is already being monitored.');
        }
        
        // Adiciona a carteira
        user.wallets.push(address);
        await user.save();

        console.log(`➕ Carteira ${address} adicionada para o usuário ${userId}`);
        ctx.reply(`✅ Wallet \`${address}\` added successfully!`, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error(`❌ Erro ao adicionar carteira para o usuário ${userId}:`, error);
        ctx.reply('An unexpected error occurred while adding the wallet. Please try again.');
    }
});


// --- LÓGICA DO WEBHOOK (STRIPE) ---
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Endpoint do Webhook
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('❌ Erro na assinatura do webhook:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    console.log(`🔔 Webhook recebido: ${event.type}`);

    // Lida com o evento de checkout bem-sucedido
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        
        try {
            const telegramId = session.metadata.telegramId;
            const newPlan = session.metadata.plan;

            if (telegramId && newPlan) {
                // Atualiza o plano do usuário no banco de dados
                await User.updateOne({ telegramId: telegramId }, { $set: { plan: newPlan } });
                
                console.log(`✅ Plano do usuário ${telegramId} atualizado para ${newPlan}`);
                
                // Envia mensagem de confirmação para o usuário no Telegram
                const planName = PLANS[newPlan]?.name || 'new';
                await bot.telegram.sendMessage(telegramId, `✅ Payment confirmed! Your plan has been upgraded to *${planName}*.`, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error('❌ Erro ao processar webhook `checkout.session.completed`:', error);
        }
    }
    
    // Outros eventos do Stripe (ex: cancelamento, falha de pagamento) podem ser tratados aqui.

    res.json({ received: true });
});

// Endpoint de verificação de saúde
app.get('/', (req, res) => {
    res.send('Bot is running and healthy.');
});

app.listen(port, () => {
    console.log(`🚀 Servidor rodando na porta ${port}`);
});

// Inicia o bot do Telegram
bot.launch()
    .then(() => console.log('🤖 Bot iniciado com sucesso!'))
    .catch(err => console.error('❌ Erro ao iniciar o bot:', err));

// Comandos para encerrar o bot de forma graciosa
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));