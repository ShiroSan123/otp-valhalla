import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Vonage } from '@vonage/server-sdk';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

dotenv.config();
// ы

const app = express();
const port = process.env.OTP_SERVER_PORT || 4000;
const clientOrigin = process.env.CLIENT_ORIGIN || '*';
const brandName = process.env.OTP_BRAND_NAME || 'Поддержка++';

app.use(
	cors({
		origin: clientOrigin === '*' ? '*' : clientOrigin.split(',').map((origin) => origin.trim()),
	})
);
app.use(express.json());

const vonageApiKey = process.env.VONAGE_API_KEY;
const vonageApiSecret = process.env.VONAGE_API_SECRET;
const vonageConfigured = Boolean(vonageApiKey && vonageApiSecret);

const vonage = vonageConfigured
	? new Vonage({
		apiKey: vonageApiKey,
		apiSecret: vonageApiSecret,
	})
	: null;

const smsRuApiId = process.env.SMSRU_API_ID;
const smsRuFrom = process.env.SMSRU_FROM;
const smsRuConfigured = Boolean(smsRuApiId);

const activeProvider = smsRuConfigured ? 'smsru' : vonageConfigured ? 'vonage' : 'mock';

const supabaseUrl =
	process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin =
	supabaseUrl && supabaseServiceKey
		? createClient(supabaseUrl, supabaseServiceKey, {
			auth: {
				autoRefreshToken: false,
				persistSession: false,
			},
		})
		: null;

const requestStore = new Map();

function normalizePhoneToE164(raw) {
	if (!raw) return '';
	const trimmed = raw.toString().trim();
	if (trimmed.startsWith('+')) return trimmed;

	const digits = trimmed.replace(/\D/g, '');
	if (!digits) return '';

	if (digits.length === 11 && digits.startsWith('8')) {
		return `+7${digits.slice(1)}`;
	}

	if (digits.length === 10 && digits.startsWith('9')) {
		return `+7${digits}`;
	}

	if (digits.length === 11 && digits.startsWith('7')) {
		return `+${digits}`;
	}

	return `+${digits}`;
}

const OTP_TTL_MS = Number(process.env.OTP_TTL_MS || 5 * 60 * 1000);

async function findSupabaseUserByPhone(phone) {
	if (!supabaseAdmin) return null;

	let page = 1;
	const perPage = 200;

	// paginate through users until we find a match or exhaust the list
	// для тестового проекта такого перебора достаточно
	while (true) {
		const { data, error } = await supabaseAdmin.auth.admin.listUsers({
			page,
			perPage,
		});

		if (error) {
			throw error;
		}

		const users = data?.users ?? [];
		const match = users.find((user) => user.phone === phone);
		if (match) return match;

		const hasMore =
			typeof data?.nextPage === 'number' && data.nextPage > page && users.length > 0;

		if (!hasMore || users.length === 0) {
			break;
		}

		page += 1;
	}

	return null;
}

async function ensureSupabaseUser(phone) {
	if (!supabaseAdmin) {
		return null;
	}

	const existing = await findSupabaseUserByPhone(phone);
	if (existing) {
		return { userId: existing.id, created: false };
	}

	const { data, error } = await supabaseAdmin.auth.admin.createUser({
		phone,
		phone_confirm: true,
	});

	if (error) {
		throw error;
	}

	return { userId: data.user?.id ?? null, created: true };
}

async function sendSmsRuCode(phone, code) {
	if (!smsRuConfigured || !smsRuApiId) {
		throw new Error('SMS.RU is not configured');
	}

	const sanitizedPhone = phone.replace(/^\+/, '');
	const body = new URLSearchParams({
		api_id: smsRuApiId,
		to: sanitizedPhone,
		msg: `Код подтверждения: ${code}`,
		json: '1',
	});

	if (smsRuFrom) {
		body.append('from', smsRuFrom);
	}

	const response = await fetch('https://sms.ru/sms/send', {
		method: 'POST',
		body,
	});

	if (!response.ok) {
		throw new Error('SMS.RU запрос завершился с ошибкой');
	}

	const payload = await response.json();

	if (payload.status !== 'OK') {
		throw new Error(payload.status_text || 'Не удалось отправить SMS');
	}

	const smsStatus =
		payload.sms?.[sanitizedPhone] ||
		(Object.values(payload.sms ?? {})[0] ?? null);
	if (smsStatus && smsStatus.status !== 'OK') {
		throw new Error(smsStatus.status_text || 'SMS не доставлено');
	}
}

app.get('/health', (_req, res) => {
	res.json({
		status: 'ok',
		provider: activeProvider,
	});
});

app.get('/', (_req, res) => {
	res.type('html').send(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>OTP Valhalla</title>
<style>
	body {
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		margin: 0;
		padding: 32px;
		background: #0c111d;
		color: #fff;
	}
	a {
		color: #a5d8ff;
	}
	code {
		background: rgba(255, 255, 255, 0.08);
		padding: 2px 4px;
		border-radius: 4px;
	}
	section {
		max-width: 720px;
		line-height: 1.5;
	}
</style>
</head>
<body>
<section>
	<h1>OTP Valhalla API</h1>
	<p>Сервис ожидает POST-запросы от клиента Hack-the-ICE 7.0.</p>
	<p>Основные конечные точки:</p>
	<ul>
		<li><code>POST /otp/request</code> — отправить SMS-код. Тело: <code>{"{ "phone": "+7..." }"}</code>.</li>
		<li><code>POST /otp/verify</code> — подтвердить код. Тело: <code>{"{ "requestId": "...", "code": "123456" }"}</code>.</li>
		<li><code>GET /health</code> — статус API.</li>
	</ul>
	<p>Базовый URL задаётся переменной <code>VITE_OTP_API_URL</code> во фронтенде.</p>
</section>
</body>
</html>`);
});

app.post('/otp/request', async (req, res) => {
	const { phone } = req.body;

	if (!phone) {
		return res.status(400).json({ message: 'phone is required' });
	}

	const normalized = normalizePhoneToE164(phone);
	if (!normalized) {
		return res.status(400).json({ message: 'invalid phone number' });
	}

	try {
		if (activeProvider === 'vonage' && vonageConfigured && vonage) {
			const response = await vonage.verify.start({
				brand: brandName,
				number: normalized,
				code_length: '6',
			});

			if (response.status !== '0') {
				console.error('Vonage verify error:', response);
				return res.status(400).json({
					message: response.error_text || 'Failed to request verification code',
				});
			}

			requestStore.set(response.request_id, {
				phone: normalized,
				expiresAt: Date.now() + OTP_TTL_MS,
				provider: 'vonage',
			});

			return res.json({
				requestId: response.request_id,
				expiresIn: OTP_TTL_MS / 1000,
			});
		}

		const requestId = randomUUID();
		const code = String(Math.floor(100000 + Math.random() * 900000));

		requestStore.set(requestId, {
			phone: normalized,
			code,
			expiresAt: Date.now() + OTP_TTL_MS,
			provider: activeProvider,
		});

		if (activeProvider === 'smsru') {
			await sendSmsRuCode(normalized, code);
		} else {
			console.log(`[OTP MOCK] ${normalized} -> ${code}`);
		}

		return res.json({
			requestId,
			expiresIn: OTP_TTL_MS / 1000,
			mock: activeProvider === 'mock',
			mockCode: activeProvider === 'mock' ? code : undefined,
		});
	} catch (error) {
		console.error('OTP request error:', error);
		const message =
			error instanceof Error
				? error.message
				: 'Failed to request verification code';

		return res
			.status(400)
			.json({ message: message || 'Failed to request verification code' });
	}
});

app.post('/otp/verify', async (req, res) => {
	const { requestId, code } = req.body;

	if (!requestId || !code) {
		return res.status(400).json({ message: 'requestId and code are required' });
	}

	const meta = requestStore.get(requestId);
	if (!meta) {
		return res.status(400).json({ message: 'verification request not found or expired' });
	}

	if (meta.expiresAt < Date.now()) {
		requestStore.delete(requestId);
		return res.status(400).json({ message: 'verification code expired' });
	}

	try {
		if (meta.provider === 'vonage' && vonageConfigured && vonage) {
			const response = await vonage.verify.check(requestId, code);

			if (response.status !== '0') {
				console.error('Vonage verify check error:', response);
				return res.status(400).json({
					message: response.error_text || 'Invalid verification code',
				});
			}

			requestStore.delete(requestId);

			let supabaseUserInfo = null;
			try {
				supabaseUserInfo = await ensureSupabaseUser(meta.phone);
			} catch (supabaseError) {
				console.error('Supabase ensure user error:', supabaseError);
			}

			return res.json({
				success: true,
				phone: meta.phone,
				supabaseUserId: supabaseUserInfo?.userId ?? null,
				supabaseUserCreated: supabaseUserInfo?.created ?? false,
			});
		}

		if (!meta.code || meta.code !== code) {
			return res.status(400).json({ message: 'Invalid verification code' });
		}

		requestStore.delete(requestId);

		let supabaseUserInfo = null;
		try {
			supabaseUserInfo = await ensureSupabaseUser(meta.phone);
		} catch (supabaseError) {
			console.error('Supabase ensure user error:', supabaseError);
		}

		return res.json({
			success: true,
			phone: meta.phone,
			mock: meta.provider === 'mock',
			supabaseUserId: supabaseUserInfo?.userId ?? null,
			supabaseUserCreated: supabaseUserInfo?.created ?? false,
		});
	} catch (error) {
		console.error('OTP verify error:', error);
		return res.status(500).json({ message: 'Failed to verify code' });
	}
});

const isRunningInVercel = Boolean(process.env.VERCEL);

if (!isRunningInVercel) {
	app.listen(port, () => {
		console.log(
			`OTP server running on http://localhost:${port}. Provider: ${activeProvider}`
		);
	});
}

export default app;
