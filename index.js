import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Vonage } from '@vonage/server-sdk';
import { createClient } from '@supabase/supabase-js';
import QRCode from 'qrcode';
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

function buildQrPayload({ requestId, phone, provider }) {
	return JSON.stringify({
		requestId,
		phone,
		provider,
		brand: brandName,
		generatedAt: new Date().toISOString(),
	});
}

async function generateQrDataUrl(payload) {
	if (!payload) return null;
	try {
		return await QRCode.toDataURL(payload, {
			errorCorrectionLevel: 'M',
			type: 'image/png',
			margin: 2,
			scale: 4,
		});
	} catch (error) {
		console.error('QR code generation error:', error);
		return null;
	}
}

function normalizeDateInput(value) {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function createOtpRequestRecord(record) {
	if (!supabaseAdmin) return null;

	const payload = {
		request_id: record.requestId,
		phone: record.phone,
		provider: record.provider,
		status: record.status ?? 'pending',
		code: record.code ?? null,
		qr_payload: record.qrPayload ?? null,
		qr_data_url: record.qrDataUrl ?? null,
		expires_at: normalizeDateInput(record.expiresAt),
		verified_at: normalizeDateInput(record.verifiedAt),
		metadata: record.metadata ?? {},
	};

	try {
		const { error } = await supabaseAdmin
			.from('otp_requests')
			.upsert(payload, { onConflict: 'request_id' });

		if (error) {
			throw error;
		}
	} catch (error) {
		console.error('Supabase store otp request error:', error);
	}
}

async function updateOtpRequestRecord(requestId, patch = {}) {
	if (!supabaseAdmin || !requestId) return null;

	const payload = {};
	if (patch.status) payload.status = patch.status;
	if ('code' in patch) payload.code = patch.code ?? null;
	if ('qrPayload' in patch) payload.qr_payload = patch.qrPayload ?? null;
	if ('qrDataUrl' in patch) payload.qr_data_url = patch.qrDataUrl ?? null;
	if ('expiresAt' in patch) payload.expires_at = normalizeDateInput(patch.expiresAt);
	if ('verifiedAt' in patch) payload.verified_at = normalizeDateInput(patch.verifiedAt);
	if ('metadata' in patch) payload.metadata = patch.metadata ?? {};

	if (Object.keys(payload).length === 0) return null;

	try {
		const { error } = await supabaseAdmin
			.from('otp_requests')
			.update(payload)
			.eq('request_id', requestId);

		if (error) {
			throw error;
		}
	} catch (error) {
		console.error('Supabase update otp request error:', error);
	}
}

async function loadRecentOtpRequests(limit = 50) {
	if (!supabaseAdmin) {
		throw new Error('Supabase is not configured');
	}

	const sanitizedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));

	const { data, error } = await supabaseAdmin
		.from('otp_requests')
		.select(
			'request_id, phone, provider, status, qr_payload, qr_data_url, created_at, expires_at, verified_at, metadata'
		)
		.order('created_at', { ascending: false })
		.limit(sanitizedLimit);

	if (error) {
		throw error;
	}

	return data ?? [];
}

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

app.get('/otp/requests', async (req, res) => {
	const limitParam = Number(req.query.limit);

	try {
		const rows = await loadRecentOtpRequests(limitParam);
		const items = rows.map((row) => ({
			requestId: row.request_id,
			phone: row.phone,
			provider: row.provider,
			status: row.status,
			createdAt: row.created_at,
			expiresAt: row.expires_at,
			verifiedAt: row.verified_at,
			metadata: row.metadata ?? {},
			qr: {
				payload: row.qr_payload,
				dataUrl: row.qr_data_url,
			},
		}));

		return res.json({ items });
	} catch (error) {
		console.error('Load OTP requests error:', error);
		return res.status(500).json({ message: 'Failed to load OTP requests' });
	}
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

	const expiresAt = Date.now() + OTP_TTL_MS;

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

			const requestId = response.request_id;
			const qrPayload = buildQrPayload({
				requestId,
				phone: normalized,
				provider: 'vonage',
			});
			const qrDataUrl = await generateQrDataUrl(qrPayload);

			requestStore.set(requestId, {
				phone: normalized,
				expiresAt,
				provider: 'vonage',
				qrPayload,
				qrDataUrl,
			});

			await createOtpRequestRecord({
				requestId,
				phone: normalized,
				provider: 'vonage',
				status: 'pending',
				qrPayload,
				qrDataUrl,
				expiresAt: new Date(expiresAt),
				metadata: { provider: 'vonage', brand: brandName },
			});

			return res.json({
				requestId,
				expiresIn: OTP_TTL_MS / 1000,
				qr: {
					payload: qrPayload,
					dataUrl: qrDataUrl,
				},
			});
		}

		const requestId = randomUUID();
		const code = String(Math.floor(100000 + Math.random() * 900000));
		const qrPayload = buildQrPayload({
			requestId,
			phone: normalized,
			provider: activeProvider,
		});
		const qrDataUrl = await generateQrDataUrl(qrPayload);

		requestStore.set(requestId, {
			phone: normalized,
			code,
			expiresAt,
			provider: activeProvider,
			qrPayload,
			qrDataUrl,
		});

		if (activeProvider === 'smsru') {
			await sendSmsRuCode(normalized, code);
		} else {
			console.log(`[OTP MOCK] ${normalized} -> ${code}`);
		}

		await createOtpRequestRecord({
			requestId,
			phone: normalized,
			provider: activeProvider,
			status: 'pending',
			code,
			qrPayload,
			qrDataUrl,
			expiresAt: new Date(expiresAt),
			metadata: { provider: activeProvider },
		});

		return res.json({
			requestId,
			expiresIn: OTP_TTL_MS / 1000,
			mock: activeProvider === 'mock',
			mockCode: activeProvider === 'mock' ? code : undefined,
			qr: {
				payload: qrPayload,
				dataUrl: qrDataUrl,
			},
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
		await updateOtpRequestRecord(requestId, { status: 'expired' });
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
			await updateOtpRequestRecord(requestId, {
				status: 'verified',
				verifiedAt: new Date(),
			});

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
		await updateOtpRequestRecord(requestId, {
			status: 'verified',
			verifiedAt: new Date(),
		});

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
