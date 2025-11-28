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
const requestPayloadLimit = process.env.OTP_REQUEST_LIMIT || '40mb';

app.use(
	cors({
		origin: clientOrigin === '*' ? '*' : clientOrigin.split(',').map((origin) => origin.trim()),
	})
);
app.use(express.json({ limit: requestPayloadLimit }));

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

const supabaseClientOptions = {
	auth: {
		autoRefreshToken: false,
		persistSession: false,
	},
};

const supabaseAdmin =
	supabaseUrl && supabaseServiceKey
		? createClient(supabaseUrl, supabaseServiceKey, supabaseClientOptions)
		: null;

const requestStore = new Map();
const UUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_PROFILE_REGION = 'xxxxxxxxx';
const DEFAULT_PROFILE_CATEGORY = 'pensioner';

function escapeHtml(value) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function calculateAgeFromBirthYear(birthYear) {
	if (typeof birthYear !== 'number') return null;
	const currentYear = new Date().getFullYear();
	if (birthYear < 1900 || birthYear > currentYear) return null;
	return currentYear - birthYear;
}

function buildQrProfileSnapshot(report) {
	if (!report || typeof report !== 'object') return null;

	const profile =
		report && typeof report === 'object' && report.profile && typeof report.profile === 'object'
			? report.profile
			: {};

	const age =
		typeof profile.age === 'number'
			? profile.age
			: calculateAgeFromBirthYear(profile.birthYear);

	const snapshot = {
		fullName: profile.name ?? null,
		region: profile.region ?? null,
		category: profile.category ?? null,
		age: age ?? null,
	};

	if ('birthYear' in profile && typeof profile.birthYear === 'number') {
		snapshot.birthYear = profile.birthYear;
	}

	if (Object.values(snapshot).every((value) => value === null)) {
		return null;
	}

	return snapshot;
}

function buildQrCareSummary(report) {
	if (!report || typeof report !== 'object') return null;

	const benefits = Array.isArray(report.benefits)
		? report.benefits
			.slice(0, 5)
			.map((benefit) => ({
				title: benefit?.title ?? null,
				type: benefit?.type ?? null,
				expiresIn: benefit?.expiresIn ?? null,
			}))
			.filter((benefit) => benefit.title)
		: [];

	const medicines = Array.isArray(report.medicines)
		? report.medicines
			.slice(0, 8)
			.map((medicine) => ({
				name: medicine?.name ?? null,
				dosage: medicine?.dosage ?? null,
				frequency: medicine?.frequency ?? null,
			}))
			.filter((medicine) => medicine.name)
		: [];

	const benefitsCount =
		typeof report?.stats?.benefitsCount === 'number'
			? report.stats.benefitsCount
			: benefits.length;
	const medicinesCount =
		typeof report?.stats?.medicinesCount === 'number'
			? report.stats.medicinesCount
			: medicines.length;

	const summary = {};
	if (benefits.length) summary.benefits = benefits;
	if (medicines.length) summary.medicines = medicines;
	if (typeof benefitsCount === 'number') summary.benefitsCount = benefitsCount;
	if (typeof medicinesCount === 'number')
		summary.medicinesCount = medicinesCount;

	if (
		!summary.benefits &&
		!summary.medicines &&
		typeof summary.benefitsCount !== 'number' &&
		typeof summary.medicinesCount !== 'number'
	) {
		return null;
	}

	return summary;
}

function buildQrPayload({ requestId, phone, provider, report }) {
	const payload = {
		requestId,
		phone,
		provider,
		brand: brandName,
		generatedAt: new Date().toISOString(),
	};

	const profileSnapshot = buildQrProfileSnapshot(report);
	const careSummary = buildQrCareSummary(report);

	if (profileSnapshot) {
		payload.profile = profileSnapshot;
	}

	if (careSummary) {
		payload.care = careSummary;
	}

	return JSON.stringify(payload);
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

function sanitizeReportMetadata(report) {
	if (!report || typeof report !== 'object') {
		return null;
	}

	try {
		return JSON.parse(JSON.stringify(report));
	} catch (error) {
		console.error('Failed to sanitize report metadata:', error);
		return null;
	}
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

function normalizePhoneDigits(value) {
	if (!value) return '';
	return value.toString().replace(/\D/g, '');
}

const OTP_TTL_MS = Number(process.env.OTP_TTL_MS || 5 * 60 * 1000);

function identityHasPhone(user, phone, normalizedTarget) {
	if (!user.identities) return false;
	const targetDigits = normalizedTarget ?? normalizePhoneDigits(phone);

	return user.identities.some((ident) => {
		const data = ident.identity_data || {};

		const candidateValues = [
			data.phone,
			data.phone_number,
			data.phoneNumber,
			data.sub,
		];

		return (
			candidateValues.some((candidate) => candidate && candidate === phone) ||
			candidateValues.some((candidate) => {
				const candidateDigits = normalizePhoneDigits(candidate);
				return (
					candidateDigits &&
					targetDigits &&
					candidateDigits === targetDigits
				);
			})
		);
	});
}

async function findSupabaseUserByPhone(phone) {
	if (!supabaseAdmin) return null;
	const normalizedPhoneDigits = normalizePhoneDigits(phone);

	let page = 1;
	const perPage = 200;

	while (true) {
		const { data, error } = await supabaseAdmin.auth.admin.listUsers({
			page,
			perPage,
		});

		if (error) {
			throw error;
		}

		const users = data?.users ?? [];

		const match = users.find((user) => {
			if (user.phone && user.phone === phone) {
				return true;
			}

			const userPhoneDigits = normalizePhoneDigits(user.phone);
			if (
				userPhoneDigits &&
				normalizedPhoneDigits &&
				userPhoneDigits === normalizedPhoneDigits
			) {
				return true;
			}

			return identityHasPhone(user, phone, normalizedPhoneDigits);
		});

		if (match) {
			return match;
		}

		const hasMore =
			typeof data?.nextPage === 'number' &&
			data.nextPage > page &&
			users.length > 0;

		if (!hasMore || users.length === 0) {
			break;
		}

		page += 1;
	}

	return null;
}

async function fetchProfileRecord(authUserId) {
	if (!supabaseAdmin) {
		throw new Error('Supabase is not configured');
	}

	if (!authUserId) {
		return null;
	}

	const { data, error } = await supabaseAdmin
		.from('profiles')
		.select('*')
		.eq('auth_user_id', authUserId)
		.maybeSingle();

	if (error) {
		throw error;
	}

	return data ?? null;
}

function buildProfileInsertPayload(input) {
	return {
		auth_user_id: input.authUserId,
		full_name: input.fullName ?? 'Пользователь',
		email: input.email ?? null,
		phone: input.phone ?? null,
		region: DEFAULT_PROFILE_REGION,
		category: DEFAULT_PROFILE_CATEGORY,
		role: 'self',
		interests: [],
		simple_mode_enabled: true,
	};
}

function buildProfileUpdatePayload(input = {}) {
	const payload = {};
	if ('fullName' in input) payload.full_name = input.fullName ?? null;
	if ('email' in input) payload.email = input.email ?? null;
	if ('phone' in input) payload.phone = input.phone ?? null;
	if ('region' in input) payload.region = input.region ?? DEFAULT_PROFILE_REGION;
	if ('category' in input) payload.category = input.category ?? DEFAULT_PROFILE_CATEGORY;
	if ('snils' in input) payload.snils = input.snils ?? null;
	if ('role' in input) payload.role = input.role ?? 'self';
	if ('interests' in input)
		payload.interests = Array.isArray(input.interests) ? input.interests : [];
	if ('simpleModeEnabled' in input)
		payload.simple_mode_enabled = Boolean(input.simpleModeEnabled);
	return payload;
}

async function ensureProfileRecord(input) {
	if (!supabaseAdmin) {
		throw new Error('Supabase is not configured');
	}

	const existing = await fetchProfileRecord(input.authUserId);
	if (existing) {
		return existing;
	}

	const payload = buildProfileInsertPayload(input);

	const { data, error } = await supabaseAdmin
		.from('profiles')
		.insert(payload)
		.select('*')
		.single();

	if (error) {
		throw error;
	}

	return data;
}

async function updateProfileRecord(authUserId, input) {
	if (!supabaseAdmin) {
		throw new Error('Supabase is not configured');
	}

	const payload = buildProfileUpdatePayload(input);
	if (Object.keys(payload).length === 0) {
		return fetchProfileRecord(authUserId);
	}

	const { data, error } = await supabaseAdmin
		.from('profiles')
		.update(payload)
		.eq('auth_user_id', authUserId)
		.select('*')
		.single();

	if (error) {
		throw error;
	}

	return data;
}

async function deleteProfileRecord(authUserId) {
	if (!supabaseAdmin) {
		throw new Error('Supabase is not configured');
	}

	const { error } = await supabaseAdmin
		.from('profiles')
		.delete()
		.eq('auth_user_id', authUserId);

	if (error) {
		throw error;
	}
}


async function ensureSupabaseUser(phone) {
	if (!supabaseAdmin) {
		return null;
	}

	const existing = await findSupabaseUserByPhone(phone);
	if (existing) {
		return { userId: existing.id, created: false };
	}

	try {
		const { data, error } = await supabaseAdmin.auth.admin.createUser({
			phone,
			phone_confirm: true,
		});

		if (error) {
			throw error;
		}

		return { userId: data.user?.id ?? null, created: true };
	} catch (error) {
		if (
			error &&
			typeof error === 'object' &&
			(error.code === 'phone_exists' || error.message?.includes('Phone number already registered'))
		) {
			const user = await findSupabaseUserByPhone(phone);
			if (user) {
				return { userId: user.id, created: false };
			}
		}
		throw error;
	}
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
			<li><code>GET /otp/requests</code> — список последних заявок с QR для печати.</li>
			<li><a href="/print"><code>/print</code></a> — страница для генерации и печати QR без отдельного клиента.</li>
		</ul>
		<h2>Что можно просить</h2>
		<p>Когда вы стучитесь в API или к печатникам, формулируйте запросы конкретно:</p>
		<ol>
			<li><strong>QR для печати.</strong> Просите <code>POST /otp/request</code>, укажите телефон получателя. В ответе придёт блок <code>qr</code> с JSON и изображением <code>dataUrl</code> — его можно сразу печатать.</li>
			<li><strong>Список активных заявок.</strong> Просите <code>GET /otp/requests?limit=50</code>, чтобы показать на сайте статус, срок действия и QR коды, которые ещё можно отсканировать.</li>
			<li><strong>Проверка статуса.</strong> Если нужен только аптайм, достаточно вызвать <code>GET /health</code> и убедиться, что провайдер в норме.</li>
			<li><strong>Верификация.</strong> После того как пользователь назвал код, делайте <code>POST /otp/verify</code> c <code>requestId</code> и <code>code</code>, чтобы завершить поток.</li>
			<li><strong>Печать без кода.</strong> Когда нет интеграции, откройте страницу <a href="/print">/print</a>, введите телефон и распечатайте полученный QR вместе с requestId.</li>
		</ol>
		<p>Бэйджи или операторы могут давать только эти четыре типа запросов; все остальные функции закрыты.</p>
		<p>Базовый URL задаётся переменной <code>VITE_OTP_API_URL</code> во фронтенде.</p>
	</section>
</body>
</html>`);
});

app.get('/print', (_req, res) => {
	const safeBrandName = escapeHtml(brandName);
	res.type('html').send(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Печать QR — ${safeBrandName}</title>
<style>
	:root {
		color-scheme: light dark;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
	}
	body {
		margin: 0;
		padding: 24px;
		background: #f3f4f6;
		color: #0c111d;
	}
	body.dark {
		background: #030711;
		color: #f8fafc;
	}
	main {
		max-width: 960px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.page-header {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 12px;
		align-items: center;
	}
	.page-header h1 {
		margin-bottom: 4px;
	}
	.back-link {
		color: #2563eb;
		text-decoration: none;
		font-weight: 600;
	}
	.back-link:hover {
		text-decoration: underline;
	}
	.card {
		background: #fff;
		color: inherit;
		padding: 20px;
		border-radius: 16px;
		box-shadow: 0 8px 30px rgba(15, 23, 42, 0.1);
	}
	body.dark .card {
		background: #111827;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	label span {
		display: block;
		font-size: 0.9rem;
		margin-bottom: 4px;
		color: rgba(15, 23, 42, 0.8);
	}
	body.dark label span {
		color: rgba(248, 250, 252, 0.7);
	}
	.label-title {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		font-size: 0.9rem;
		color: rgba(15, 23, 42, 0.85);
		margin-bottom: 4px;
	}
	body.dark .label-title {
		color: rgba(248, 250, 252, 0.75);
	}
	.link-btn {
		margin-left: auto;
		border: none;
		background: none;
		padding: 0;
		font-size: 0.85rem;
		font-weight: 600;
		color: #2563eb;
		cursor: pointer;
	}
	.link-btn:hover {
		text-decoration: underline;
	}
	input[type="tel"] {
		font-size: 1.2rem;
		padding: 12px 14px;
		border-radius: 12px;
		border: 1px solid rgba(15, 23, 42, 0.2);
		background: rgba(15, 23, 42, 0.02);
		color: inherit;
	}
	body.dark input[type="tel"] {
		border-color: rgba(248, 250, 252, 0.2);
		background: rgba(248, 250, 252, 0.05);
		color: inherit;
	}
	textarea {
		width: 100%;
		min-height: 160px;
		padding: 12px 14px;
		border-radius: 12px;
		border: 1px solid rgba(15, 23, 42, 0.2);
		background: rgba(15, 23, 42, 0.02);
		color: inherit;
		font-family: 'SFMono-Regular', ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace;
		font-size: 0.85rem;
		line-height: 1.4;
		resize: vertical;
	}
	body.dark textarea {
		border-color: rgba(248, 250, 252, 0.2);
		background: rgba(248, 250, 252, 0.05);
		color: inherit;
	}
	#qr-payload {
		min-height: 220px;
	}
	.actions {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
	}
	button {
		font-size: 1rem;
		font-weight: 600;
		border: none;
		border-radius: 12px;
		padding: 12px 20px;
		cursor: pointer;
		transition: opacity 0.2s ease;
	}
	button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.primary {
		background: #2563eb;
		color: #fff;
	}
	.secondary {
		background: rgba(15, 23, 42, 0.08);
		color: inherit;
	}
	body.dark .secondary {
		background: rgba(248, 250, 252, 0.12);
		color: inherit;
	}
	.hint {
		font-size: 0.9rem;
		color: rgba(15, 23, 42, 0.7);
		margin: -4px 0 0;
	}
	body.dark .hint {
		color: rgba(248, 250, 252, 0.65);
	}
	#error {
		padding: 12px 16px;
		border-radius: 12px;
		background: #fee2e2;
		color: #991b1b;
	}
	body.dark #error {
		background: rgba(254, 226, 226, 0.1);
		color: #fecaca;
	}
	.result {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.badge {
		display: grid;
		grid-template-columns: minmax(220px, 260px) 1fr;
		gap: 24px;
		align-items: center;
	}
	@media (max-width: 720px) {
		.badge {
			grid-template-columns: 1fr;
		}
	}
	#qr-image {
		width: 100%;
		aspect-ratio: 1/1;
		background: #fff;
		border-radius: 12px;
		object-fit: contain;
		border: 1px solid rgba(15, 23, 42, 0.1);
	}
	.meta-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 12px 18px;
		font-size: 1rem;
	}
	.meta-grid span {
		display: block;
		font-size: 0.85rem;
		color: rgba(15, 23, 42, 0.6);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		margin-bottom: 2px;
	}
	body.dark .meta-grid span {
		color: rgba(248, 250, 252, 0.5);
	}
	.meta-grid strong {
		font-size: 1.05rem;
	}
	textarea {
		width: 100%;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
		border-radius: 12px;
		padding: 12px 14px;
		border: 1px solid rgba(15, 23, 42, 0.2);
		background: rgba(15, 23, 42, 0.02);
		color: inherit;
		min-height: 120px;
	}
	body.dark textarea {
		border-color: rgba(248, 250, 252, 0.2);
		background: rgba(248, 250, 252, 0.04);
	}
	.print-note {
		font-size: 0.85rem;
		color: rgba(15, 23, 42, 0.6);
	}
	body.dark .print-note {
		color: rgba(248, 250, 252, 0.45);
	}
	@media print {
		body {
			background: #fff;
			color: #000;
			padding: 0;
		}
		.card, form, .hint, .page-header a, .actions, #error {
			display: none !important;
		}
		.result {
			display: block;
			box-shadow: none;
			padding: 0;
		}
		.result .card {
			box-shadow: none;
			border: 1px solid #000;
		}
		textarea {
			border: 1px solid #000;
		}
	}
</style>
</head>
<body>
<main>
	<header class="page-header">
		<div>
			<h1>Печать QR — ${safeBrandName}</h1>
			<p>Введите номер телефона, чтобы сформировать QR и распечатать наклейку или бэйдж. QR пригоден для сканирования штатными приложениями.</p>
		</div>
		<a class="back-link" href="/">← Документация API</a>
	</header>
	<form id="qr-form" class="card" autocomplete="off">
		<label>
			<span>Номер телефона (E.164)</span>
			<input id="phone" type="tel" name="phone" placeholder="+79991234567" pattern="^\\+?\\d{11,15}$" required />
		</label>
		<label>
			<span class="label-title">
				JSON-отчёт (можно отредактировать перед отправкой)
				<button type="button" class="link-btn" id="report-reset-btn">Заполнить примером</button>
			</span>
			<textarea id="report-json" name="report" rows="10" spellcheck="false" placeholder='{"profile":{"name":"Пользователь"}}'></textarea>
			<p class="hint">Данные попадут в поле <code>report</code> и сохранятся в metadata Supabase.</p>
		</label>
		<div class="actions">
			<button class="primary" type="submit" id="generate-btn">Сгенерировать QR</button>
			<button class="secondary" type="button" data-action="print" disabled>Печать</button>
		</div>
		<p class="hint">Страница вызывает <code>POST /otp/request</code> и сохраняет QR в Supabase вместе c requestId.</p>
	</form>
	<div id="error" hidden role="alert"></div>
	<section id="result" class="result" hidden>
		<div class="card badge">
			<div>
				<img id="qr-image" alt="QR-код" />
				<p class="print-note">Совет: при печати используйте высокое качество и не масштабируйте изображение.</p>
			</div>
			<div class="meta-grid">
				<div>
					<span>Телефон</span>
					<strong id="meta-phone">—</strong>
				</div>
				<div>
					<span>Request ID</span>
					<strong id="meta-request-id">—</strong>
				</div>
				<div>
					<span>Сгенерирован</span>
					<strong id="meta-generated">—</strong>
				</div>
				<div>
					<span>Действителен до</span>
					<strong id="meta-expires">—</strong>
				</div>
				<div>
					<span>Провайдер</span>
					<strong id="meta-provider">—</strong>
				</div>
				<div>
					<span>Бренд</span>
					<strong>${safeBrandName}</strong>
				</div>
				<div>
					<span>JSON-отчёт</span>
					<strong id="meta-report-status">—</strong>
				</div>
			</div>
		</div>
		<div class="card">
			<label>
				<span>QR payload (можно вставить в PDF или отдать на проверку)</span>
				<textarea id="qr-payload" readonly></textarea>
			</label>
		</div>
	</section>
</main>
<script>
(() => {
	const prefersDarkMode = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
	if (prefersDarkMode) {
		document.body.classList.toggle('dark', prefersDarkMode.matches);
		const handleSchemeChange = (event) => {
			document.body.classList.toggle('dark', event.matches);
		};
		if (typeof prefersDarkMode.addEventListener === 'function') {
			prefersDarkMode.addEventListener('change', handleSchemeChange);
		} else if (typeof prefersDarkMode.addListener === 'function') {
			prefersDarkMode.addListener(handleSchemeChange);
		}
	}

	const form = document.getElementById('qr-form');
	const phoneInput = document.getElementById('phone');
	const errorBox = document.getElementById('error');
	const resultSection = document.getElementById('result');
	const qrImage = document.getElementById('qr-image');
	const payloadField = document.getElementById('qr-payload');
	const reportField = document.getElementById('report-json');
	const metaPhone = document.getElementById('meta-phone');
	const metaRequestId = document.getElementById('meta-request-id');
	const metaExpires = document.getElementById('meta-expires');
	const metaGenerated = document.getElementById('meta-generated');
	const metaProvider = document.getElementById('meta-provider');
	const metaReportStatus = document.getElementById('meta-report-status');
	const printButton = document.querySelector('[data-action="print"]');
	const submitButton = document.getElementById('generate-btn');
	const resetReportButton = document.getElementById('report-reset-btn');
	const defaultSubmitText = submitButton.textContent;

	function setLoading(isLoading) {
		if (isLoading) {
			submitButton.disabled = true;
			submitButton.textContent = 'Создаём...';
		} else {
			submitButton.disabled = false;
			submitButton.textContent = defaultSubmitText;
		}
	}

	function showError(message) {
		if (!message) {
			errorBox.hidden = true;
			errorBox.textContent = '';
			return;
		}
		errorBox.hidden = false;
		errorBox.textContent = message;
	}

	function formatDate(value) {
		const date = value instanceof Date ? value : new Date(value);
		if (Number.isNaN(date.getTime())) {
			return '—';
		}
		return date.toLocaleString('ru-RU', { hour12: false });
	}

	function buildSampleReport(phoneValue) {
		const now = new Date();
		const isoNow = now.toISOString();
		const digits = (phoneValue || '').replace(/[^\d]/g, '');
		const profileId = digits ? 'print-' + digits.slice(-6) : 'print-user';
		return {
			generatedAt: isoNow,
			printDateLabel: now.toLocaleString('ru-RU', {
				day: '2-digit',
				month: 'long',
				year: 'numeric',
				hour: '2-digit',
				minute: '2-digit',
			}),
			profile: {
				id: profileId,
				name: 'Пользователь',
				region: 'Москва',
				category: 'pensioner',
			},
			stats: {
				benefitsCount: 2,
				totalBenefitSavings: 12500,
				medicinesCount: 1,
				totalMedicineCost: 1800,
			},
			soonExpiring: {
				id: 'benefit-urgent',
				title: 'Компенсация ЖКУ',
				expiresIn: 12,
				validTo: null,
			},
			benefits: [
				{
					id: 'benefit-1',
					title: 'Бесплатный проезд',
					description: 'Компенсация поездок на городском транспорте.',
					type: 'transport',
					targetGroups: ['pensioner'],
					regions: ['Москва', 'all'],
					validFrom: isoNow,
					validTo: null,
					requirements: ['Паспорт', 'Социальная карта москвича'],
					documents: ['Заявление в МФЦ', 'Удостоверение льготника'],
					steps: [
						'Подайте заявление в МФЦ или на Госуслугах',
						'Дождитесь уведомления',
						'Получите подтверждение и обновите карту',
					],
					partner: 'Департамент транспорта',
					savingsPerMonth: 2200,
					expiresIn: 120,
				},
				{
					id: 'benefit-2',
					title: 'Скидка на ЖКУ',
					description: 'Компенсация 50% расходов на коммунальные услуги.',
					type: 'utility',
					targetGroups: ['pensioner'],
					regions: ['Москва', 'all'],
					validFrom: isoNow,
					validTo: null,
					requirements: ['Регистрация в регионе', 'Отсутствие задолженности'],
					documents: ['Паспорт', 'Справка о составе семьи'],
					steps: ['Соберите документы', 'Подайте заявление в соцзащиту', 'Получите перечисление'],
					partner: 'МФЦ Москва',
					savingsPerMonth: 5300,
					expiresIn: 45,
				},
			],
			medicines: [
				{
					id: 'medicine-1',
					name: 'Эналаприл',
					dosage: '10 мг',
					frequency: '2 раза в день',
					prescribedBy: 'Терапевт',
					prescribedDate: isoNow,
					refillDate: isoNow,
					monthlyPrice: 980,
					discountedPrice: 0,
				},
			],
		};
	}

	function resetReportField(phoneValue) {
		if (!reportField) return;
		const sample = buildSampleReport(phoneValue || phoneInput.value.trim() || '+79991234567');
		reportField.value = JSON.stringify(sample, null, 2);
	}

	function getReportPayload(phoneValue) {
		if (!reportField) return null;
		const raw = reportField.value.trim();
		if (!raw) return null;
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (parseError) {
			throw new Error('Проверьте JSON отчёта — не удалось распарсить данные.');
		}
		const now = new Date();
		parsed.generatedAt = now.toISOString();
		if (!parsed.printDateLabel) {
			parsed.printDateLabel = now.toLocaleString('ru-RU', {
				day: '2-digit',
				month: 'long',
				year: 'numeric',
				hour: '2-digit',
				minute: '2-digit',
			});
		}
		if (!parsed.profile || typeof parsed.profile !== 'object') {
			parsed.profile = {};
		}
		if (!parsed.profile.id) {
			const digits = (phoneValue || '').replace(/[^\d]/g, '');
			parsed.profile.id = digits ? 'print-' + digits.slice(-6) : 'print-user';
		}
		return parsed;
	}

	if (reportField && !reportField.value.trim()) {
		resetReportField();
	}
	if (resetReportButton) {
		resetReportButton.addEventListener('click', (event) => {
			event.preventDefault();
			resetReportField();
		});
	}

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		const phone = phoneInput.value.trim();
		if (!phone) {
			showError('Введите номер телефона');
			return;
		}

		let reportPayload = null;
		try {
			reportPayload = getReportPayload(phone);
		} catch (reportError) {
			showError(reportError && reportError.message ? reportError.message : 'Невалидный JSON отчёта');
			return;
		}

		showError('');
		resultSection.hidden = true;
		printButton.disabled = true;
		setLoading(true);

		try {
			const payload = reportPayload ? { phone, report: reportPayload } : { phone };
			const response = await fetch('/otp/request', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			const data = await response.json();
			if (!response.ok) {
				throw new Error(data && data.message ? data.message : 'Не удалось создать QR');
			}
			if (!data || !data.qr || !data.qr.dataUrl) {
				throw new Error('Ответ сервера не содержит QR');
			}

			qrImage.src = data.qr.dataUrl;
			qrImage.alt = 'QR-код для ' + phone;

			metaPhone.textContent = data.phone || phone;
			metaRequestId.textContent = data.requestId || '—';

			const expiresAtMs = typeof data.expiresIn === 'number'
				? Date.now() + data.expiresIn * 1000
				: null;
			metaExpires.textContent = expiresAtMs ? formatDate(expiresAtMs) : '—';

			let payloadData = null;
			if (data.qr.payload) {
				payloadField.value = data.qr.payload;
				try {
					payloadData = JSON.parse(data.qr.payload);
				} catch (parseError) {
					payloadData = null;
				}
			} else {
				payloadField.value = '';
			}

			if (payloadData && payloadData.generatedAt) {
				metaGenerated.textContent = formatDate(payloadData.generatedAt);
			} else {
				metaGenerated.textContent = formatDate(new Date());
			}

			if (payloadData && payloadData.provider) {
				metaProvider.textContent = payloadData.provider;
			} else if (data.mock) {
				metaProvider.textContent = 'mock';
			} else {
				metaProvider.textContent = '—';
			}
			if (metaReportStatus) {
				if (typeof data.reportCaptured === 'boolean') {
					metaReportStatus.textContent = data.reportCaptured
						? 'Сохранён'
						: reportPayload
							? 'Не сохранён'
							: '—';
				} else if (reportPayload) {
					metaReportStatus.textContent = 'Отправлен';
				} else {
					metaReportStatus.textContent = '—';
				}
			}

			resultSection.hidden = false;
			printButton.disabled = false;
		} catch (error) {
			console.error('QR generation error', error);
			showError(error && error.message ? error.message : 'Не удалось создать QR');
		} finally {
			setLoading(false);
		}
	});

	printButton.addEventListener('click', () => {
		window.print();
	});

	phoneInput.focus();
})();
</script>
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

app.post('/profiles/ensure', async (req, res) => {
	if (!supabaseAdmin) {
		return res.status(500).json({ message: 'Supabase is not configured' });
	}

	const { authUserId, fullName, email, phone } = req.body ?? {};
	if (!authUserId || !UUID_REGEX.test(authUserId)) {
		return res.status(400).json({ message: 'Valid authUserId is required' });
	}

	try {
		const profile = await ensureProfileRecord({
			authUserId,
			fullName,
			email,
			phone,
		});
		return res.json({ profile });
	} catch (error) {
		console.error('Profiles ensure error:', error);
		return res.status(500).json({ message: 'Failed to ensure profile' });
	}
});

app.put('/profiles/:authUserId', async (req, res) => {
	if (!supabaseAdmin) {
		return res.status(500).json({ message: 'Supabase is not configured' });
	}

	const { authUserId } = req.params;
	if (!authUserId || !UUID_REGEX.test(authUserId)) {
		return res.status(400).json({ message: 'Valid authUserId is required' });
	}

	try {
		const profile = await updateProfileRecord(authUserId, req.body ?? {});
		return res.json({ profile });
	} catch (error) {
		console.error('Profiles update error:', error);
		return res.status(500).json({ message: 'Failed to update profile' });
	}
});

app.delete('/profiles/:authUserId', async (req, res) => {
	if (!supabaseAdmin) {
		return res.status(500).json({ message: 'Supabase is not configured' });
	}

	const { authUserId } = req.params;
	if (!authUserId || !UUID_REGEX.test(authUserId)) {
		return res.status(400).json({ message: 'Valid authUserId is required' });
	}

	try {
		await deleteProfileRecord(authUserId);
		return res.json({ success: true });
	} catch (error) {
		console.error('Profiles delete error:', error);
		return res.status(500).json({ message: 'Failed to delete profile' });
	}
});

app.post('/otp/request', async (req, res) => {
	const { phone, report } = req.body;

	if (!phone) {
		return res.status(400).json({ message: 'phone is required' });
	}

	const normalized = normalizePhoneToE164(phone);
	if (!normalized) {
		return res.status(400).json({ message: 'invalid phone number' });
	}

	const sanitizedReportMetadata = sanitizeReportMetadata(report);
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
				report: sanitizedReportMetadata,
			});
			const qrDataUrl = await generateQrDataUrl(qrPayload);

			requestStore.set(requestId, {
				phone: normalized,
				expiresAt,
				provider: 'vonage',
				qrPayload,
				qrDataUrl,
			});

			const recordMetadata = {
				provider: 'vonage',
				brand: brandName,
			};
			if (sanitizedReportMetadata) {
				recordMetadata.report = sanitizedReportMetadata;
			}

			await createOtpRequestRecord({
				requestId,
				phone: normalized,
				provider: 'vonage',
				status: 'pending',
				qrPayload,
				qrDataUrl,
				expiresAt: new Date(expiresAt),
				metadata: recordMetadata,
			});

			return res.json({
				requestId,
				expiresIn: OTP_TTL_MS / 1000,
				reportCaptured: Boolean(sanitizedReportMetadata),
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
			report: sanitizedReportMetadata,
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

		const recordMetadata = { provider: activeProvider, brand: brandName };
		if (sanitizedReportMetadata) {
			recordMetadata.report = sanitizedReportMetadata;
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
			metadata: recordMetadata,
		});

		return res.json({
			requestId,
			expiresIn: OTP_TTL_MS / 1000,
			mock: activeProvider === 'mock',
			mockCode: activeProvider === 'mock' ? code : undefined,
			reportCaptured: Boolean(sanitizedReportMetadata),
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
	console.log('[/otp/verify] body =', req.body);
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
