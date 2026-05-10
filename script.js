import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut, EmailAuthProvider, reauthenticateWithCredential, updatePassword } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js";
import { getFirestore, doc, setDoc, updateDoc, collection, query, where, onSnapshot, runTransaction, serverTimestamp, orderBy, limit, getDocs, increment, addDoc, deleteField } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";

// CONFIGURAÇÃO FIREBASE (MANTENHA A SUA)
const firebaseConfig = {
  apiKey: "AIzaSyBkl7Vt5WHMoiU3mThXiG7hAzv1T0FvSRI",
  authDomain: "glassbank-c411b.firebaseapp.com",
  projectId: "glassbank-c411b",
  storageBucket: "glassbank-c411b.firebasestorage.app",
  messagingSenderId: "222854977565",
  appId: "1:222854977565:web:c654f9a0dbf47665f7cef4"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// --- ESTADO GLOBAL ---
let currentUser = null;
let currentTaxRate = 0.02;
let dailyRewardValue = 50;
let html5QrcodeScanner = null;
let scannerIsRunning = false;
let pendingTransaction = null;
let currentTransactions = [];
let stockMarketInitialized = false;
let unsubUser = null;
let unsubTransactions = null;
let unsubCity = null;
let unsubPolls = null;
let unsubAdminTransactions = null;
let unsubAdminLogs = null;
let unsubRiskUsers = null;
let currentNotifications = [];
let currentAdminTransactions = [];
let currentAdminLogs = [];
let currentRiskUsers = [];
let currentPublicTaxHidden = false;
let currentTotalTaxCollected = 0;
let activeHistoryFilter = 'all';

const CITY_HALL_ID = "vTFqk1ZX8NfwzuE4ZmJKXnfoI9r1";
const QR_PREFIX = "GBANK";
const LOAN_LIMIT = 5000;
const LOAN_WINDOW_LIMIT = 5000;
const LOAN_WINDOW_HOURS = 24;
const LOAN_COOLDOWN_HOURS = 6;
const LOAN_MIN_ACCOUNT_MINUTES = 30;
const HIGH_NEGATIVE_ALERT = -1000;
const MAX_CONTACTS = 15;
const MAX_NOTIFICATION_READ_IDS = 200;
const MAX_NOTIFICATION_ITEMS = 40;
const PASSWORD_CHANGE_COOLDOWN_MINUTES = 30;
const MAX_INVESTMENT_POLLS = 40;

const toErrorMessage = (error) => {
    if (typeof error === 'string') return error;
    if (error && typeof error.message === 'string') return error.message;
    return 'Ocorreu um erro inesperado.';
};

const toNumber = (value) => Number.parseFloat(String(value).replace(',', '.'));
const formatMoney = (value) => `R$ ${Number(value || 0).toFixed(2)}`;
const timestampToDate = (timestamp, fallback = new Date(0)) => {
    if (timestamp && typeof timestamp.toDate === 'function') return timestamp.toDate();
    if (timestamp instanceof Date) return timestamp;
    const numeric = Number(timestamp);
    if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric);
    return fallback;
};
const enc = new TextEncoder();
const allowedRoles = new Set(['user', 'merchant']);

function bytesToHex(bytes) {
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(size = 16) {
    const array = new Uint8Array(size);
    crypto.getRandomValues(array);
    return bytesToHex(array);
}

async function sha256Hex(value) {
    const data = enc.encode(value);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return bytesToHex(new Uint8Array(hash));
}

async function makePinHash(pin) {
    const pinSalt = randomHex(16);
    const pinHash = await sha256Hex(`${pinSalt}:${pin}`);
    return { pinSalt, pinHash };
}

async function checkPin(pin, pinSalt, pinHash) {
    if (!pinSalt || !pinHash) return false;
    const computed = await sha256Hex(`${pinSalt}:${pin}`);
    return computed === pinHash;
}

async function verifyAndMigratePin(user, candidatePin) {
    if (await checkPin(candidatePin, user.pinSalt, user.pinHash)) return true;
    if (typeof user.pin === 'string' && candidatePin === user.pin) {
        const next = await makePinHash(candidatePin);
        await updateDoc(doc(db, "users", user.uid), {
            pinHash: next.pinHash,
            pinSalt: next.pinSalt,
            pin: deleteField()
        });
        return true;
    }
    return false;
}

async function generateUniqueShortId(maxAttempts = 20) {
    for (let i = 0; i < maxAttempts; i += 1) {
        const candidate = randomHex(4).slice(0, 6).toUpperCase();
        const existing = await getDocs(query(collection(db, "users"), where("shortId", "==", candidate), limit(1)));
        if (existing.empty) return candidate;
    }
    throw new Error("Falha ao gerar ID curto unico. Tente novamente.");
}

function hasGovernmentAccess(userData = currentUser) {
    return userData?.role === 'admin' || userData?.uid === CITY_HALL_ID;
}

function ensureAdmin() {
    if (!hasGovernmentAccess()) {
        showToast("Acao restrita a prefeitura.", "error");
        return false;
    }
    return true;
}

function formatTransactionId(rawId) {
    const clean = String(rawId || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    return `TX${clean.slice(0, 10) || Date.now()}`;
}

function formatAuthCode(hashHex) {
    const clean = String(hashHex || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
    const sized = (clean + '0000000000000000').slice(0, 16);
    return `${sized.slice(0, 4)}-${sized.slice(4, 8)}-${sized.slice(8, 12)}-${sized.slice(12, 16)}`;
}

async function buildReceiptAuthCode(payload) {
    const hashHex = await sha256Hex(JSON.stringify(payload));
    return formatAuthCode(hashHex);
}

function fillText(id, value) {
    const el = document.getElementById(id);
    if (el) el.innerText = value;
}

function formatDateTime(date) {
    return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function timestampToMillis(timestamp, fallback = 0) {
    if (timestamp && typeof timestamp.toMillis === 'function') return timestamp.toMillis();
    if (timestamp instanceof Date) return timestamp.getTime();
    const numeric = Number(timestamp);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function formatStatus(status) {
    if (status === 'estornada') return 'Estornada';
    if (status === 'aguardando_verba') return 'Aguardando verba';
    return 'Concluida';
}

function buildTransactionRecord(rawId, data) {
    const amount = Number(data.amount || 0);
    const tax = Number(data.tax || 0);
    const total = Number((data.total ?? (amount + tax)).toFixed(2));
    return {
        ...data,
        txId: formatTransactionId(rawId),
        amount,
        tax,
        total,
        method: data.method || 'Sistema',
        status: data.status || 'concluida',
        timestamp: serverTimestamp()
    };
}

function getPasswordChangeLocalKey(uid = currentUser?.uid) {
    return uid ? `glassbank:lastPasswordChangeAt:${uid}` : '';
}

function getPasswordLastChangedMs(userData = currentUser) {
    const docMs = timestampToMillis(userData?.lastPasswordChangeAt, 0);
    let localMs = 0;
    const key = getPasswordChangeLocalKey(userData?.uid);
    if (key) {
        try {
            localMs = Number(window.localStorage.getItem(key) || 0);
        } catch (_) {
            localMs = 0;
        }
    }
    return Math.max(docMs, localMs);
}

function getPasswordCooldownRemainingMs(userData = currentUser) {
    const lastChangedMs = getPasswordLastChangedMs(userData);
    if (!lastChangedMs) return 0;
    const cooldownMs = PASSWORD_CHANGE_COOLDOWN_MINUTES * 60 * 1000;
    return Math.max(0, cooldownMs - (Date.now() - lastChangedMs));
}

function setLocalPasswordChangedAt(timestampMs = Date.now(), uid = currentUser?.uid) {
    const key = getPasswordChangeLocalKey(uid);
    if (!key) return;
    try {
        window.localStorage.setItem(key, String(timestampMs));
    } catch (_) {
        // Local fallback is optional.
    }
}

function canReceiveWelfare(userData = currentUser) {
    return userData?.welfareEligible !== false;
}

function getStoredInvestmentPolls(data) {
    const rawPolls = Array.isArray(data?.investmentPolls) ? data.investmentPolls : [];
    return rawPolls
        .map((poll, index) => {
            const createdAtMs = timestampToMillis(poll?.createdAt, Number(poll?.createdAtMs || 0));
            const updatedAtMs = timestampToMillis(poll?.updatedAt, Number(poll?.updatedAtMs || createdAtMs || 0));
            return {
                id: String(poll?.id || `poll-${index + 1}`),
                title: String(poll?.title || '').trim(),
                cost: Number(poll?.cost || 0),
                targetVotes: Math.max(1, Number.parseInt(poll?.targetVotes, 10) || 1),
                votes: Math.max(0, Number.parseInt(poll?.votes, 10) || 0),
                status: ['open', 'aguardando_verba', 'funded', 'estornada'].includes(poll?.status) ? poll.status : 'open',
                voters: Array.isArray(poll?.voters) ? poll.voters.filter((voter) => typeof voter === 'string') : [],
                createdAtMs,
                updatedAtMs
            };
        })
        .filter((poll) => poll.title)
        .sort((a, b) => Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0));
}

function makeInvestmentPollId(existingPolls = []) {
    const taken = new Set(existingPolls.map((poll) => String(poll.id)));
    let candidate = '';
    do {
        candidate = `POLL${randomHex(4).slice(0, 8).toUpperCase()}`;
    } while (taken.has(candidate));
    return candidate;
}

function renderInvestmentPolls(polls) {
    const list = document.getElementById('polls-list');
    if (!list) return;
    list.innerHTML = "";

    const visiblePolls = polls
        .filter((poll) => ['open', 'aguardando_verba', 'funded'].includes(poll.status || 'open'))
        .sort((a, b) => Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0));

    if (!visiblePolls.length) {
        renderEmptyState(list, 'Nenhuma enquete ativa no momento.');
        return;
    }

    visiblePolls.forEach((p) => {
        const votes = Number(p.votes || 0);
        const targetVotes = Math.max(1, Number(p.targetVotes || 1));
        const cost = Number(p.cost || 0);
        const percent = Math.min(100, (votes / targetVotes) * 100);
        const pollStatus = p.status || 'open';

        const div = document.createElement('div');
        div.className = 'poll-card';

        const rowTop = document.createElement('div');
        rowTop.style.display = 'flex';
        rowTop.style.justifyContent = 'space-between';

        const titleStrong = document.createElement('strong');
        titleStrong.textContent = p.title || 'Sem titulo';

        const costSpan = document.createElement('span');
        costSpan.textContent = formatMoney(cost);

        rowTop.appendChild(titleStrong);
        rowTop.appendChild(costSpan);

        const progress = document.createElement('div');
        progress.className = 'poll-progress';
        const bar = document.createElement('div');
        bar.className = 'poll-bar';
        bar.style.width = `${percent}%`;
        progress.appendChild(bar);

        const rowBottom = document.createElement('div');
        rowBottom.style.display = 'flex';
        rowBottom.style.justifyContent = 'space-between';
        rowBottom.style.alignItems = 'center';

        const votesSmall = document.createElement('small');
        votesSmall.textContent = `${votes} / ${targetVotes} votos`;

        const statusSmall = document.createElement('small');
        statusSmall.textContent = pollStatus === 'funded'
            ? 'Projeto financiado'
            : pollStatus === 'aguardando_verba'
                ? 'Meta atingida, aguardando verba'
                : 'Aberta para votos';

        const voteBtn = document.createElement('button');
        voteBtn.textContent = pollStatus === 'open' ? 'Votar' : 'Acompanhar';
        voteBtn.style.width = 'auto';
        voteBtn.style.padding = '5px 15px';
        voteBtn.style.margin = '0';
        voteBtn.disabled = pollStatus !== 'open';
        voteBtn.addEventListener('click', () => window.votePoll(p.id));

        const copyWrap = document.createElement('div');
        copyWrap.style.display = 'flex';
        copyWrap.style.flexDirection = 'column';
        copyWrap.appendChild(votesSmall);
        copyWrap.appendChild(statusSmall);

        rowBottom.appendChild(copyWrap);

        const btnsWrap = document.createElement('div');
        btnsWrap.style.cssText = 'display:flex; gap:6px; align-items:center;';
        btnsWrap.appendChild(voteBtn);

        if (hasGovernmentAccess()) {
            const deleteBtn = document.createElement('button');
            deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
            deleteBtn.title = 'Remover enquete';
            deleteBtn.style.cssText = 'width:auto; padding:5px 10px; margin:0; background:rgba(255,77,106,0.15); color:#ff6b85; border:1px solid rgba(255,77,106,0.3); border-radius:8px; cursor:pointer;';
            deleteBtn.addEventListener('click', () => window.deletePoll(p.id));
            btnsWrap.appendChild(deleteBtn);
        }

        rowBottom.appendChild(btnsWrap);

        div.appendChild(rowTop);
        div.appendChild(progress);
        div.appendChild(rowBottom);
        list.appendChild(div);
    });
}

function renderTaxVisibility(totalTaxCollected = 0, hidePublicTaxTotal = false) {
    currentPublicTaxHidden = Boolean(hidePublicTaxTotal);
    const totalEl = document.getElementById('total-tax-collected');
    const noteEl = document.getElementById('total-tax-visibility-note');
    const statusEl = document.getElementById('tax-visibility-status');
    const toggleBtn = document.getElementById('toggle-tax-visibility-btn');
    const viewerIsGovernment = hasGovernmentAccess();

    if (totalEl) {
        totalEl.innerText = currentPublicTaxHidden && !viewerIsGovernment ? 'Oculto' : formatMoney(totalTaxCollected);
    }

    if (noteEl) {
        noteEl.classList.remove('hidden');
        noteEl.innerText = currentPublicTaxHidden
            ? (viewerIsGovernment ? 'Total oculto do publico. A prefeitura ainda ve o valor real.' : 'Total oculto pela prefeitura neste momento.')
            : 'Total visivel para todos.';
    }

    if (statusEl) {
        statusEl.innerText = currentPublicTaxHidden
            ? 'Total publico oculto. Apenas a prefeitura visualiza o numero real.'
            : 'Total visivel para todos no portal.';
    }

    if (toggleBtn) {
        toggleBtn.innerText = currentPublicTaxHidden ? 'Mostrar total publico' : 'Ocultar total publico';
    }
}

function renderPasswordSecurity() {
    const statusEl = document.getElementById('password-cooldown-status');
    const button = document.getElementById('change-password-btn');
    if (!statusEl || !button) return;

    const remainingMs = getPasswordCooldownRemainingMs(currentUser);
    if (remainingMs > 0) {
        button.disabled = true;
        statusEl.innerText = `Nova troca liberada em ${Math.ceil(remainingMs / (60 * 1000))} min.`;
    } else {
        button.disabled = false;
        statusEl.innerText = 'Você pode alterar sua senha agora.';
    }
}

function getUserContacts() {
    return Array.isArray(currentUser?.contacts) ? [...currentUser.contacts] : [];
}

function getReadNotificationIds() {
    return Array.isArray(currentUser?.readNotificationIds) ? currentUser.readNotificationIds : [];
}

function getLoanState(userData = currentUser) {
    const now = Date.now();
    const balance = Number(userData?.balance || 0);
    const loanOutstanding = Number(userData?.loanOutstanding || 0);
    const createdAtMs = timestampToMillis(userData?.createdAt, now);
    const accountAgeMinutes = Math.max(0, (now - createdAtMs) / (1000 * 60));
    const lastLoanAtMs = timestampToMillis(userData?.lastLoanAt, 0);
    const cooldownRemainingMs = Math.max(0, (LOAN_COOLDOWN_HOURS * 60 * 60 * 1000) - (now - lastLoanAtMs));
    const loanWindowStartedAtMs = timestampToMillis(userData?.loanWindowStartedAt, 0);
    const windowActive = loanWindowStartedAtMs > 0 && (now - loanWindowStartedAtMs) < (LOAN_WINDOW_HOURS * 60 * 60 * 1000);
    const borrowedThisWindow = windowActive ? Number(userData?.borrowedThisWindow || 0) : 0;
    const dynamicLimit = Math.min(LOAN_LIMIT, Math.max(500, 1000 + Math.max(0, balance) * 0.5));
    const remainingWindowLimit = Math.max(0, LOAN_WINDOW_LIMIT - borrowedThisWindow);
    const availableLimit = accountAgeMinutes < LOAN_MIN_ACCOUNT_MINUTES || cooldownRemainingMs > 0 || loanOutstanding > 0
        ? 0
        : Math.min(dynamicLimit, remainingWindowLimit);

    return {
        accountAgeMinutes,
        availableLimit,
        borrowedThisWindow,
        cooldownRemainingMs,
        dynamicLimit,
        loanOutstanding,
        remainingWindowLimit,
        windowActive
    };
}

async function logSystemFailure(source, error, context = {}) {
    try {
        await addDoc(collection(db, "systemLogs"), {
            source,
            message: toErrorMessage(error),
            context,
            level: 'error',
            timestamp: serverTimestamp()
        });
    } catch (_) {
        // Logging failure should never block the main flow.
    }
}

async function ensureUserDefaults(uid, data) {
    const patch = {};
    if (!Array.isArray(data.contacts)) patch.contacts = [];
    if (!Array.isArray(data.readNotificationIds)) patch.readNotificationIds = [];
    if (!Number.isFinite(Number(data.loanOutstanding))) patch.loanOutstanding = 0;
    if (!Number.isFinite(Number(data.borrowedThisWindow))) patch.borrowedThisWindow = 0;
    if (!('loanWindowStartedAt' in data)) patch.loanWindowStartedAt = null;
    if (!('lastLoanAt' in data)) patch.lastLoanAt = null;
    if (!('lastLoanRepaymentAt' in data)) patch.lastLoanRepaymentAt = null;
    if (!('lastPasswordChangeAt' in data)) patch.lastPasswordChangeAt = null;
    if (!('welfareEligible' in data)) patch.welfareEligible = true;
    if (uid === CITY_HALL_ID) {
        if (!('hidePublicTaxTotal' in data)) patch.hidePublicTaxTotal = false;
        if (!Array.isArray(data.investmentPolls)) patch.investmentPolls = [];
    }
    if (Object.keys(patch).length) {
        await updateDoc(doc(db, "users", uid), patch);
    }
}

function cleanupListeners() {
    if (unsubUser) unsubUser();
    if (unsubTransactions) unsubTransactions();
    if (unsubCity) unsubCity();
    if (unsubPolls) unsubPolls();
    if (unsubAdminTransactions) unsubAdminTransactions();
    if (unsubAdminLogs) unsubAdminLogs();
    if (unsubRiskUsers) unsubRiskUsers();
    unsubUser = null;
    unsubTransactions = null;
    unsubCity = null;
    unsubPolls = null;
    unsubAdminTransactions = null;
    unsubAdminLogs = null;
    unsubRiskUsers = null;
    currentAdminTransactions = [];
    currentAdminLogs = [];
    currentRiskUsers = [];
    currentNotifications = [];
    currentPublicTaxHidden = false;
    currentTotalTaxCollected = 0;
}

// --- SONS & UI ---
const playSound = (type) => {
    const id = type === 'success' ? 'snd-success' : type === 'error' ? 'snd-error' : 'snd-click';
    const audio = document.getElementById(id);
    if(audio) { audio.currentTime = 0; audio.play().catch(e => {}); }
};

const showToast = (msg, type = 'success') => {
    playSound(type);
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.style.cssText = `
        background: ${type === 'error' ? 'rgba(255,77,106,0.12)' : 'rgba(0,232,124,0.10)'};
        color: ${type === 'error' ? '#ff6b85' : '#00e87c'};
        border: 1px solid ${type === 'error' ? 'rgba(255,77,106,0.35)' : 'rgba(0,232,124,0.35)'};
        padding: 13px 16px;
        margin-bottom: 8px;
        border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.4);
        font-family: 'Figtree', sans-serif;
        font-size: 0.88rem;
        font-weight: 500;
        backdrop-filter: blur(12px);
        line-height: 1.4;
    `;
    toast.innerText = toErrorMessage(msg);
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
};

function navTo(sectionId) {
    playSound('click');
    document.querySelectorAll('section').forEach(s => s.classList.remove('active-section'));
    document.querySelectorAll('section').forEach(s => s.classList.add('hidden'));
    
    const target = document.getElementById(sectionId + '-section');
    if(target) {
        target.classList.remove('hidden');
        target.classList.add('active-section');
    }
    
    if (sectionId === 'qr-scan') startScanner();
    else stopScanner();
}
window.navTo = navTo;

function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.add('hidden');
    if (id === 'pin-modal') {
        pendingTransaction = null;
        const pinInput = document.getElementById('confirm-pin-input');
        if (pinInput) pinInput.value = '';
    }
}
window.closeModal = closeModal;

function toggleAuth(mode) {
    const isReg = mode === 'register';
    document.getElementById('fullname').style.display = isReg ? 'block' : 'none';
    document.getElementById('role-select').style.display = isReg ? 'block' : 'none';
    document.getElementById('reg-pin').style.display = isReg ? 'block' : 'none';
    document.getElementById('auth-btn').innerText = isReg ? 'Cadastrar' : 'Entrar';
    document.getElementById('auth-form').dataset.mode = mode;
    document.querySelectorAll('.auth-tabs button').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.querySelector(`.auth-tabs button[onclick="toggleAuth('${mode}')"]`);
    if (activeBtn) activeBtn.classList.add('active');
}
window.toggleAuth = toggleAuth;

// --- AUTH & INIT ---
const authForm = document.getElementById('auth-form');
authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('auth-btn');
    btn.disabled = true; btn.innerText = "Aguarde...";
    const mode = authForm.dataset.mode || 'login';
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;

    try {
        if (mode === 'register') {
            const name = document.getElementById('fullname').value.trim();
            const role = document.getElementById('role-select').value;
            const pin = document.getElementById('reg-pin').value.trim();
            if (!name) throw new Error("Informe seu nome completo.");
            if (!/^\d{4,6}$/.test(pin)) throw new Error("PIN deve ter entre 4 e 6 dígitos.");
            if (!allowedRoles.has(role)) throw new Error("Tipo de conta inválido.");

            const userCred = await createUserWithEmailAndPassword(auth, email, password);
            const shortId = await generateUniqueShortId();
            const { pinHash, pinSalt } = await makePinHash(pin);
            // Criação do documento do usuário
            await setDoc(doc(db, "users", userCred.user.uid), {
                name: name, email: email, role: role, pinHash, pinSalt,
                shortId: shortId,
                balance: 1000.00,
                savingsBalance: 0,
                stocks: { glasscoin: 0 },
                contacts: [],
                readNotificationIds: [],
                lastDailyClaim: null,
                lastPasswordChangeAt: null,
                loanOutstanding: 0,
                borrowedThisWindow: 0,
                loanWindowStartedAt: null,
                lastLoanAt: null,
                lastLoanRepaymentAt: null,
                welfareEligible: true,
                status: 'active',
                lastInterestDate: serverTimestamp(),
                lastDebtInterestDate: serverTimestamp(),
                lastSavingsInterestDate: serverTimestamp(),
                createdAt: serverTimestamp()
            });
            showToast("Bem-vindo ao GlassBank!");
        } else {
            await signInWithEmailAndPassword(auth, email, password);
        }
    } catch (err) { showToast(toErrorMessage(err), 'error'); }
    finally { btn.disabled = false; btn.innerText = mode==='register'?'Cadastrar':'Entrar'; }
});

onAuthStateChanged(auth, (user) => {
    if (user) {
        document.getElementById('auth-section').classList.remove('active-section');
        navTo('dashboard');
        initializeUser(user.uid);
    } else {
        cleanupListeners();
        stopScanner();
        navTo('auth');
        currentUser = null;
        currentTransactions = [];
    }
});

// --- MAIN USER LOGIC (COM JUROS E NOVIDADES) ---
function initializeUser(uid) {
    if (unsubUser) unsubUser();
    unsubUser = onSnapshot(doc(db, "users", uid), async (docSnap) => {
        if (!docSnap.exists()) {
            showToast('Cadastro do usuário não encontrado.', 'error');
            return;
        }

        currentUser = { ...docSnap.data(), uid };
        ensureUserDefaults(uid, currentUser).catch(() => {});
        if (currentUser.status === 'banned') {
            signOut(auth);
            alert("Conta Banida");
            return;
        }

        const userName = currentUser.name || 'Usuário';
        const role = currentUser.role || 'user';
        const balance = Number(currentUser.balance || 0);

        document.getElementById('user-name').innerText = userName;
        document.getElementById('user-role').innerText = role === 'admin' ? 'Prefeitura' : role === 'merchant' ? 'Comércio' : 'Cidadão';
        document.getElementById('user-balance').innerText = formatMoney(balance);
        document.getElementById('user-short-id').innerText = currentUser.shortId || '---';
        document.getElementById('user-avatar').src = `https://ui-avatars.com/api/?name=${encodeURIComponent(userName)}&background=random&color=fff`;

        document.getElementById('savings-balance').innerText = formatMoney(currentUser.savingsBalance || 0);
        document.getElementById('user-stock-count').innerText = Number(currentUser.stocks?.glasscoin || 0);

        const loanBadge = document.getElementById('loan-indicator');
        loanBadge.style.display = balance < 0 || Number(currentUser.loanOutstanding || 0) > 0 ? 'inline-block' : 'none';

        checkDailyRewardStatus();
        updateTransferPreview();
        generateQR();
        renderLoanPanel();
        renderContactLists();
        renderNotifications();
        renderPasswordSecurity();

        if (hasGovernmentAccess()) {
            document.getElementById('admin-btn').classList.remove('hidden');
            initAdminPanel();
            initAdminMonitor();
        } else {
            document.getElementById('admin-btn').classList.add('hidden');
            if (unsubAdminTransactions) unsubAdminTransactions();
            if (unsubAdminLogs) unsubAdminLogs();
            if (unsubRiskUsers) unsubRiskUsers();
            unsubAdminTransactions = null;
            unsubAdminLogs = null;
            unsubRiskUsers = null;
            currentAdminTransactions = [];
            currentAdminLogs = [];
            currentRiskUsers = [];
            renderAdminMonitor();
        }

        await processInterests(uid);
    });

    listenToTransactions(uid);
    syncSystemData();
    initStockMarket();
    initStaticListeners();
}

// Processamento de Juros (Dívida 5% a cada 10min / Poupança 0.5% a cada 60min)
async function processInterests(uid) {
    if (!currentUser) return;

    const now = new Date();
    const lastDebtDate = timestampToDate(currentUser.lastDebtInterestDate || currentUser.lastInterestDate, now);
    const lastSavingsDate = timestampToDate(currentUser.lastSavingsInterestDate || currentUser.lastInterestDate, now);
    const debtMinutes = (now - lastDebtDate) / (1000 * 60);
    const savingsMinutes = (now - lastSavingsDate) / (1000 * 60);

    const debtIntervals = Math.floor(debtMinutes / 10);
    if (Number(currentUser.loanOutstanding || 0) > 0 && debtIntervals > 0) {
        const currentDebt = Number(currentUser.loanOutstanding || 0);
        const newDebt = Number((currentDebt * Math.pow(1.05, debtIntervals)).toFixed(2));
        const interestAmount = Number((newDebt - currentDebt).toFixed(2));

        await runTransaction(db, async (t) => {
            const userRef = doc(db, "users", uid);
            t.update(userRef, {
                loanOutstanding: newDebt,
                lastInterestDate: serverTimestamp(),
                lastDebtInterestDate: serverTimestamp()
            });
            const txRef = doc(collection(db, "transactions"));
            t.set(txRef, buildTransactionRecord(txRef.id, {
                senderId: 'SYSTEM',
                senderName: 'Banco Central',
                senderShortId: 'SYSTEM',
                receiverId: uid,
                receiverName: currentUser.name,
                receiverShortId: currentUser.shortId || uid,
                amount: interestAmount,
                type: 'interest_loan',
                method: 'Sistema',
                participants: [uid]
            }));
        });
        showToast(`Juros do emprestimo: ${formatMoney(interestAmount)}`, 'error');
    } else if (Number(currentUser.balance || 0) < 0 && debtIntervals > 0) {
        const currentDebt = Number(currentUser.balance || 0);
        const newDebt = Number((currentDebt * Math.pow(1.05, debtIntervals)).toFixed(2));
        const interestAmount = Number(Math.abs(newDebt - currentDebt).toFixed(2));

        await runTransaction(db, async (t) => {
            const userRef = doc(db, "users", uid);
            t.update(userRef, {
                balance: newDebt,
                lastInterestDate: serverTimestamp(),
                lastDebtInterestDate: serverTimestamp()
            });
            const txRef = doc(collection(db, "transactions"));
            t.set(txRef, buildTransactionRecord(txRef.id, {
                senderId: 'SYSTEM',
                senderName: 'Banco Central',
                senderShortId: 'SYSTEM',
                receiverId: uid,
                receiverName: currentUser.name,
                receiverShortId: currentUser.shortId || uid,
                amount: interestAmount,
                type: 'interest_overdraft',
                method: 'Sistema',
                participants: [uid]
            }));
        });
        showToast(`Juros de saldo negativo: ${formatMoney(interestAmount)}`, 'error');
    }

    const savingsIntervals = Math.floor(savingsMinutes / 60);
    if (Number(currentUser.savingsBalance || 0) > 0 && savingsIntervals > 0) {
        const currentSavings = Number(currentUser.savingsBalance || 0);
        const newSavings = currentSavings * Math.pow(1.005, savingsIntervals);
        const yieldAmount = newSavings - currentSavings;

        await updateDoc(doc(db, "users", uid), {
            savingsBalance: newSavings,
            lastInterestDate: serverTimestamp(),
            lastSavingsInterestDate: serverTimestamp()
        });

        const txRef = doc(collection(db, "transactions"));
        await setDoc(txRef, buildTransactionRecord(txRef.id, {
            senderId: 'SYSTEM',
            senderName: 'Cofre Rendimento',
            senderShortId: 'SYSTEM',
            receiverId: uid,
            receiverName: currentUser.name,
            receiverShortId: currentUser.shortId || uid,
            amount: yieldAmount,
            type: 'interest_yield',
            method: 'Sistema',
            participants: [uid]
        }));
        showToast(`Rendimento da Poupança: +${formatMoney(yieldAmount)}`);
    }
}

// --- SISTEMA PREFEITURA & TRANSPARÊNCIA ---
function syncSystemData() {
    if (unsubCity) unsubCity();
    if (unsubPolls) unsubPolls();
    unsubPolls = null;

    unsubCity = onSnapshot(doc(db, "users", CITY_HALL_ID), (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        currentTaxRate = Number(data.customTax || 0.02);
        dailyRewardValue = Number(data.dailyRewardAmount || 50);
        currentTotalTaxCollected = Number(data.totalTaxCollected || 0);

        document.getElementById('city-hall-balance').innerText = formatMoney(data.balance || 0);
        renderTaxVisibility(currentTotalTaxCollected, Boolean(data.hidePublicTaxTotal));
        document.getElementById('tax-display').innerText = `${(currentTaxRate * 100).toFixed(1)}%`;
        updateTransferPreview();
        renderInvestmentPolls(getStoredInvestmentPolls(data));
        checkDailyRewardStatus();

        if (hasGovernmentAccess()) {
            updateSliderUI(currentTaxRate * 100);
            const rewardInput = document.getElementById('admin-daily-reward');
            if (rewardInput && document.activeElement !== rewardInput) {
                rewardInput.value = dailyRewardValue.toFixed(2);
            }
            initAdminPanel();
        }
    });
}

// --- INVESTIMENTOS ---
// 1. Poupança
window.savingsAction = async (type) => {
    if (!currentUser) return;
    let amount = prompt(`Valor para ${type === 'deposit' ? 'Guardar' : 'Sacar'}:`);
    amount = toNumber(amount);
    if (!Number.isFinite(amount) || amount <= 0) return;

    try {
        if (type === 'deposit') {
            if (Number(currentUser.balance || 0) < amount) return showToast("Saldo insuficiente", "error");
            await updateDoc(doc(db, "users", currentUser.uid), {
                balance: increment(-amount),
                savingsBalance: increment(amount)
            });
        } else {
            if (Number(currentUser.savingsBalance || 0) < amount) return showToast("Saldo no cofre insuficiente", "error");
            await updateDoc(doc(db, "users", currentUser.uid), {
                balance: increment(amount),
                savingsBalance: increment(-amount)
            });
        }
        showToast("Operação no Cofre realizada!");
    } catch (e) {
        showToast(toErrorMessage(e), "error");
    }
};

// 2. Bolsa de Valores (Simulada no Cliente para todos verem igual, idealmente seria server-side)
// Para simulação simples: O preço é baseado no minuto atual (Determinístico) para todos verem o mesmo.
function initStockMarket() {
    if (stockMarketInitialized) return;
    stockMarketInitialized = true;

    const updateStock = () => {
        const now = Date.now();
        // Algoritmo pseudo-aleatório baseado no tempo (preço muda a cada 10s)
        const timeSeed = Math.floor(now / 10000); 
        const basePrice = 50; 
        const variation = Math.sin(timeSeed) * 20; // Oscila entre -20 e +20
        const price = basePrice + variation;
        
        const priceEl = document.getElementById('stock-price');
        if (!priceEl) return;
        const oldPrice = toNumber(priceEl.innerText.replace('R$ ', '')) || price;
        
        priceEl.innerText = formatMoney(price);
        
        const trendEl = document.getElementById('stock-trend');
        if (!trendEl) return;
        const variationPercent = oldPrice ? (Math.abs((price - oldPrice) / oldPrice) * 100) : 0;
        if (price > oldPrice) {
            trendEl.innerHTML = `▲ ${variationPercent.toFixed(2)}%`;
            trendEl.className = "trend-up";
            trendEl.style.color = "var(--accent)";
        } else {
            trendEl.innerHTML = `▼ ${variationPercent.toFixed(2)}%`;
            trendEl.className = "trend-down";
            trendEl.style.color = "var(--danger)";
        }
        
        window.currentStockPrice = price;
    };

    updateStock();
    setInterval(updateStock, 5000);
}

window.tradeStock = async (action) => {
    if (!currentUser) return;
    const price = window.currentStockPrice;
    if (!price) return;
    
    try {
        if(action === 'buy') {
            if(Number(currentUser.balance || 0) < price) return showToast("Saldo insuficiente", "error");
            await updateDoc(doc(db, "users", currentUser.uid), {
                balance: increment(-price),
                "stocks.glasscoin": increment(1)
            });
        } else {
            if(!currentUser.stocks?.glasscoin || currentUser.stocks.glasscoin < 1) return showToast("Você não tem ações", "error");
            await updateDoc(doc(db, "users", currentUser.uid), {
                balance: increment(price),
                "stocks.glasscoin": increment(-1)
            });
        }
        playSound('click');
    } catch (e) {
        showToast(toErrorMessage(e), "error");
    }
};

// --- RECOMPENSA DIÁRIA ---
function checkDailyRewardStatus() {
    if (!currentUser) return;
    const area = document.getElementById('daily-reward-area');
    const button = document.getElementById('claim-reward-btn');
    const statusEl = document.getElementById('daily-reward-status');
    if (!area || !button || !statusEl) return;
    const now = new Date();
    const last = timestampToDate(currentUser.lastDailyClaim, new Date(0));
    const diffHours = (now - last) / (1000 * 60 * 60);
    const rewardReady = diffHours >= 24;
    const eligible = canReceiveWelfare(currentUser);

    area.classList.remove('hidden');
    if (!eligible) {
        button.disabled = true;
        button.innerText = 'Bloqueado';
        statusEl.innerText = 'Auxilio bloqueado para esta conta pela prefeitura.';
    } else if (rewardReady) {
        button.disabled = false;
        button.innerText = 'Resgatar';
        statusEl.innerText = `Disponivel agora: ${formatMoney(dailyRewardValue)}.`;
    } else {
        button.disabled = true;
        button.innerText = 'Aguardar';
        statusEl.innerText = `Novo resgate liberado em ${Math.ceil(24 - diffHours)}h.`;
    }
}

window.claimDailyReward = async () => {
    if (!currentUser) return;
    try {
        await runTransaction(db, async (t) => {
            const cityRef = doc(db, "users", CITY_HALL_ID);
            const userRef = doc(db, "users", currentUser.uid);
            
            const cityDoc = await t.get(cityRef);
            const userDoc = await t.get(userRef);
            if (!cityDoc.exists()) throw new Error("Prefeitura não encontrada.");
            if (!userDoc.exists()) throw new Error("Usuário não encontrado.");
            if (userDoc.data().welfareEligible === false) throw new Error("Esta conta nao pode receber auxilio no momento.");

            const lastClaim = timestampToDate(userDoc.data().lastDailyClaim, new Date(0));
            const diffHours = (Date.now() - lastClaim.getTime()) / (1000 * 60 * 60);
            if (diffHours < 24) throw new Error("Auxílio já resgatado nas últimas 24h.");
            if (Number(cityDoc.data().balance || 0) < dailyRewardValue) throw new Error("Prefeitura sem verba para auxílio!");

            t.update(cityRef, { balance: increment(-dailyRewardValue) });
            t.update(userRef, { 
                balance: increment(dailyRewardValue),
                lastDailyClaim: serverTimestamp()
            });

            const txRef = doc(collection(db, "transactions"));
            t.set(txRef, buildTransactionRecord(txRef.id, {
                senderId: CITY_HALL_ID,
                senderName: "Prefeitura (Auxilio)",
                senderShortId: 'CITY',
                receiverId: currentUser.uid,
                receiverName: currentUser.name,
                receiverShortId: currentUser.shortId || currentUser.uid,
                amount: dailyRewardValue,
                type: 'welfare',
                method: 'Sistema',
                participants: [currentUser.uid, CITY_HALL_ID]
            }));
        });
        showToast(`Recebeu ${formatMoney(dailyRewardValue)}!`);
        checkDailyRewardStatus();
    } catch(e) {
        logSystemFailure('claimDailyReward', e, { userId: currentUser?.uid }).catch(() => {});
        showToast(toErrorMessage(e), 'error');
    }
};

function renderEmptyState(container, message) {
    if (!container) return;
    const item = document.createElement('div');
    item.className = 'empty-state';
    item.innerText = message;
    container.appendChild(item);
}

function sortContacts(contacts) {
    return [...contacts].sort((a, b) => {
        if (Boolean(b.isFavorite) !== Boolean(a.isFavorite)) return Number(Boolean(b.isFavorite)) - Number(Boolean(a.isFavorite));
        return Number(b.lastUsedAt || 0) - Number(a.lastUsedAt || 0);
    }).slice(0, MAX_CONTACTS);
}

async function persistContacts(mutator) {
    if (!currentUser) return;
    const nextContacts = sortContacts(mutator(getUserContacts()));
    await updateDoc(doc(db, "users", currentUser.uid), { contacts: nextContacts });
}

async function saveContactUsage(shortId, nameSnapshot) {
    await persistContacts((contacts) => {
        const now = Date.now();
        const next = [...contacts];
        const index = next.findIndex((contact) => contact.shortId === shortId);
        if (index >= 0) {
            next[index] = {
                ...next[index],
                nameSnapshot: nameSnapshot || next[index].nameSnapshot || shortId,
                lastUsedAt: now,
                useCount: Number(next[index].useCount || 0) + 1
            };
        } else {
            next.push({
                shortId,
                nickname: '',
                nameSnapshot: nameSnapshot || shortId,
                isFavorite: false,
                lastUsedAt: now,
                useCount: 1
            });
        }
        return next;
    });
}

async function toggleFavoriteContact(shortId) {
    await persistContacts((contacts) => contacts.map((contact) => contact.shortId === shortId
        ? { ...contact, isFavorite: !contact.isFavorite }
        : contact));
}

async function renameContact(shortId) {
    const current = getUserContacts().find((contact) => contact.shortId === shortId);
    const nickname = prompt('Apelido para este contato:', current?.nickname || current?.nameSnapshot || shortId);
    if (nickname === null) return;
    await persistContacts((contacts) => contacts.map((contact) => contact.shortId === shortId
        ? { ...contact, nickname: nickname.trim() }
        : contact));
}

function useContact(shortId) {
    const input = document.getElementById('dest-id');
    if (!input) return;
    input.value = shortId;
    navTo('transfer');
    updateTransferPreview();
}

function renderContactGroup(containerId, contacts, emptyMessage) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    if (!contacts.length) {
        renderEmptyState(container, emptyMessage);
        return;
    }

    contacts.forEach((contact) => {
        const card = document.createElement('div');
        card.className = 'contact-card';

        const copy = document.createElement('div');
        copy.className = 'contact-copy';

        const title = document.createElement('strong');
        title.innerText = contact.nickname || contact.nameSnapshot || contact.shortId;

        const meta = document.createElement('small');
        meta.innerText = `${contact.shortId} • ${Number(contact.useCount || 0)}x`;

        copy.appendChild(title);
        copy.appendChild(meta);

        const actions = document.createElement('div');
        actions.className = 'contact-actions';

        const fillButton = document.createElement('button');
        fillButton.className = 'secondary small-btn';
        fillButton.innerText = 'Usar';
        fillButton.addEventListener('click', () => useContact(contact.shortId));

        const favoriteButton = document.createElement('button');
        favoriteButton.className = 'secondary small-btn';
        favoriteButton.innerText = contact.isFavorite ? 'Desfavoritar' : 'Favoritar';
        favoriteButton.addEventListener('click', () => toggleFavoriteContact(contact.shortId).catch((error) => {
            logSystemFailure('toggleFavoriteContact', error, { shortId: contact.shortId }).catch(() => {});
            showToast(toErrorMessage(error), 'error');
        }));

        const renameButton = document.createElement('button');
        renameButton.className = 'secondary small-btn';
        renameButton.innerText = 'Apelido';
        renameButton.addEventListener('click', () => renameContact(contact.shortId).catch((error) => {
            logSystemFailure('renameContact', error, { shortId: contact.shortId }).catch(() => {});
            showToast(toErrorMessage(error), 'error');
        }));

        actions.appendChild(fillButton);
        actions.appendChild(favoriteButton);
        actions.appendChild(renameButton);

        card.appendChild(copy);
        card.appendChild(actions);
        container.appendChild(card);
    });
}

function renderContactLists() {
    const contacts = sortContacts(getUserContacts());
    const favorites = contacts.filter((contact) => contact.isFavorite);
    const recents = contacts.filter((contact) => !contact.isFavorite);
    renderContactGroup('favorite-contacts', favorites, 'Nenhum favorito salvo ainda.');
    renderContactGroup('recent-contacts', recents, 'As ultimas transferencias aparecem aqui.');
}

function buildNotificationsFromTransactions() {
    if (!currentUser) return [];
    const items = [];

    currentTransactions.forEach((transaction) => {
        const executedAt = timestampToDate(transaction.timestamp, new Date(0));
        const taxAmount = Number(transaction.tax || 0);
        const totalAmount = Number(transaction.total || (Number(transaction.amount || 0) + taxAmount));
        const senderIsCurrent = transaction.senderId === currentUser.uid;
        const receiverIsCurrent = transaction.receiverId === currentUser.uid;

        if (transaction.type === 'transfer') {
            if (senderIsCurrent) {
                items.push({
                    id: `${transaction.id}:sent`,
                    transactionId: transaction.id,
                    type: 'enviado',
                    title: 'Pix enviado',
                    description: `Para ${transaction.receiverName || transaction.receiverShortId || 'destino'}`,
                    amount: totalAmount,
                    date: executedAt
                });
                if (taxAmount > 0) {
                    items.push({
                        id: `${transaction.id}:tax`,
                        transactionId: transaction.id,
                        type: 'imposto',
                        title: 'Imposto debitado',
                        description: 'Taxa municipal aplicada na transferencia',
                        amount: taxAmount,
                        date: executedAt
                    });
                }
            } else if (receiverIsCurrent) {
                items.push({
                    id: `${transaction.id}:received`,
                    transactionId: transaction.id,
                    type: 'recebido',
                    title: 'Pix recebido',
                    description: `De ${transaction.senderName || transaction.senderShortId || 'origem'}`,
                    amount: Number(transaction.amount || 0),
                    date: executedAt
                });
            }
        }

        if (transaction.type === 'interest_yield') {
            items.push({
                id: `${transaction.id}:yield`,
                transactionId: transaction.id,
                type: 'juros',
                title: 'Rendimento creditado',
                description: 'Juros da poupanca',
                amount: Number(transaction.amount || 0),
                date: executedAt
            });
        }

        if (transaction.type === 'interest_loan' || transaction.type === 'interest_overdraft') {
            items.push({
                id: `${transaction.id}:interest`,
                transactionId: transaction.id,
                type: 'juros',
                title: 'Juros aplicados',
                description: transaction.type === 'interest_loan' ? 'Juros do emprestimo ativo' : 'Juros de saldo negativo',
                amount: Number(transaction.amount || 0),
                date: executedAt
            });
        }

        if (transaction.type === 'loan') {
            items.push({
                id: `${transaction.id}:loan`,
                transactionId: transaction.id,
                type: 'recebido',
                title: 'Credito aprovado',
                description: 'Emprestimo liberado pelo banco',
                amount: Number(transaction.amount || 0),
                date: executedAt
            });
        }

        if (transaction.type === 'loan_payment') {
            items.push({
                id: `${transaction.id}:loan-payment`,
                transactionId: transaction.id,
                type: 'enviado',
                title: 'Amortizacao registrada',
                description: 'Pagamento de divida bancaria',
                amount: Number(transaction.amount || 0),
                date: executedAt
            });
        }
    });

    return items
        .sort((a, b) => b.date - a.date)
        .slice(0, MAX_NOTIFICATION_ITEMS);
}

async function markNotificationRead(notificationId) {
    if (!currentUser) return;
    const next = [...new Set([...getReadNotificationIds(), notificationId])].slice(-MAX_NOTIFICATION_READ_IDS);
    await updateDoc(doc(db, "users", currentUser.uid), { readNotificationIds: next });
}

window.markAllNotificationsRead = async () => {
    if (!currentUser) return;
    try {
        const next = [...new Set([...getReadNotificationIds(), ...currentNotifications.map((item) => item.id)])].slice(-MAX_NOTIFICATION_READ_IDS);
        await updateDoc(doc(db, "users", currentUser.uid), { readNotificationIds: next });
    } catch (error) {
        logSystemFailure('markAllNotificationsRead', error, { userId: currentUser.uid }).catch(() => {});
        showToast(toErrorMessage(error), 'error');
    }
};

function renderNotifications() {
    const list = document.getElementById('notifications-list');
    const badge = document.getElementById('notification-badge');
    if (!list || !badge) return;

    currentNotifications = buildNotificationsFromTransactions();
    const readIds = new Set(getReadNotificationIds());
    const unreadCount = currentNotifications.filter((item) => !readIds.has(item.id)).length;
    badge.innerText = String(unreadCount);
    badge.classList.toggle('hidden', unreadCount === 0);

    list.innerHTML = '';
    if (!currentNotifications.length) {
        renderEmptyState(list, 'Nenhuma notificacao encontrada.');
        return;
    }

    currentNotifications.forEach((notification) => {
        const card = document.createElement('div');
        card.className = `notification-card ${readIds.has(notification.id) ? '' : 'unread'}`.trim();

        const copy = document.createElement('div');
        copy.className = 'notification-copy';

        const title = document.createElement('strong');
        title.innerText = notification.title;

        const description = document.createElement('small');
        description.innerText = `${notification.description} • ${formatMoney(notification.amount)}`;

        const meta = document.createElement('small');
        meta.innerText = `${notification.type.toUpperCase()} • ${formatDateTime(notification.date)}`;

        copy.appendChild(title);
        copy.appendChild(description);
        copy.appendChild(meta);

        const actions = document.createElement('div');
        actions.className = 'notification-actions';

        const detailButton = document.createElement('button');
        detailButton.className = 'secondary small-btn';
        detailButton.innerText = 'Detalhes';
        detailButton.addEventListener('click', () => {
            const transaction = currentTransactions.find((item) => item.id === notification.transactionId);
            if (transaction) openTransactionDetails(transaction);
        });

        actions.appendChild(detailButton);
        if (!readIds.has(notification.id)) {
            const readButton = document.createElement('button');
            readButton.className = 'secondary small-btn';
            readButton.innerText = 'Marcar lido';
            readButton.addEventListener('click', () => markNotificationRead(notification.id).catch((error) => {
                logSystemFailure('markNotificationRead', error, { notificationId: notification.id }).catch(() => {});
                showToast(toErrorMessage(error), 'error');
            }));
            actions.appendChild(readButton);
        }

        card.appendChild(copy);
        card.appendChild(actions);
        list.appendChild(card);
    });
}

function renderAdminList(containerId, items, emptyMessage, renderer) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    if (!items.length) {
        renderEmptyState(container, emptyMessage);
        return;
    }
    items.forEach((item) => container.appendChild(renderer(item)));
}

function renderAdminMonitor() {
    renderAdminList('admin-transactions-list', currentAdminTransactions, 'Nenhuma transacao monitorada.', (transaction) => {
        const item = document.createElement('div');
        item.className = 'monitor-item';
        const title = document.createElement('strong');
        title.innerText = transaction.txId || formatTransactionId(transaction.id);
        const meta = document.createElement('small');
        meta.innerText = `${(transaction.type || 'transaction').toUpperCase()} • ${formatMoney(transaction.total || transaction.amount || 0)} • ${formatStatus(transaction.status)}`;
        item.appendChild(title);
        item.appendChild(meta);
        return item;
    });

    renderAdminList('admin-failures-list', currentAdminLogs, 'Nenhuma falha registrada.', (failure) => {
        const item = document.createElement('div');
        item.className = 'monitor-item';
        const title = document.createElement('strong');
        title.innerText = failure.source || 'app';
        const meta = document.createElement('small');
        meta.innerText = `${failure.message || 'Falha sem mensagem'} • ${formatDateTime(timestampToDate(failure.timestamp, new Date()))}`;
        item.appendChild(title);
        item.appendChild(meta);
        return item;
    });

    renderAdminList('admin-alerts-list', currentRiskUsers, 'Nenhum alerta no momento.', (user) => {
        const item = document.createElement('div');
        item.className = 'monitor-item';
        const title = document.createElement('strong');
        title.innerText = `${user.name || 'Usuario'} (${user.shortId || '---'})`;
        const meta = document.createElement('small');
        meta.innerText = `Saldo: ${formatMoney(user.balance || 0)} • Divida: ${formatMoney(user.loanOutstanding || 0)}`;
        item.appendChild(title);
        item.appendChild(meta);
        return item;
    });
}

function initAdminMonitor() {
    if (!hasGovernmentAccess()) return;
    if (!unsubAdminTransactions) {
        const q = query(collection(db, "transactions"), orderBy("timestamp", "desc"), limit(50));
        unsubAdminTransactions = onSnapshot(q, (snap) => {
            currentAdminTransactions = [];
            snap.forEach((docSnap) => currentAdminTransactions.push({ id: docSnap.id, ...docSnap.data() }));
            renderAdminMonitor();
        });
    }

    if (!unsubAdminLogs) {
        const q = query(collection(db, "systemLogs"), orderBy("timestamp", "desc"), limit(50));
        unsubAdminLogs = onSnapshot(q, (snap) => {
            currentAdminLogs = [];
            snap.forEach((docSnap) => {
                const data = docSnap.data();
                if (data.level === 'error') currentAdminLogs.push({ id: docSnap.id, ...data });
            });
            renderAdminMonitor();
        });
    }

    if (!unsubRiskUsers) {
        unsubRiskUsers = onSnapshot(collection(db, "users"), (snap) => {
            currentRiskUsers = [];
            snap.forEach((docSnap) => {
                if (docSnap.id === CITY_HALL_ID) return;
                const data = docSnap.data();
                if (Number(data.balance || 0) <= HIGH_NEGATIVE_ALERT || Number(data.loanOutstanding || 0) >= LOAN_LIMIT) {
                    currentRiskUsers.push({ id: docSnap.id, ...data });
                }
            });
            currentRiskUsers.sort((a, b) => (Number(a.balance || 0) + Number(a.loanOutstanding || 0)) - (Number(b.balance || 0) + Number(b.loanOutstanding || 0)));
            renderAdminMonitor();
        });
    }
}

function renderLoanPanel() {
    if (!currentUser) return;
    const state = getLoanState(currentUser);
    fillText('loan-limit-display', formatMoney(state.availableLimit));
    fillText('loan-debt-display', formatMoney(state.loanOutstanding));

    if (state.accountAgeMinutes < LOAN_MIN_ACCOUNT_MINUTES) {
        fillText('loan-status-copy', `Conta nova. Aguarde ${Math.ceil(LOAN_MIN_ACCOUNT_MINUTES - state.accountAgeMinutes)} min para credito.`);
    } else if (state.loanOutstanding > 0) {
        fillText('loan-status-copy', 'Existe uma divida ativa. Quite antes de novo credito.');
    } else if (state.cooldownRemainingMs > 0) {
        fillText('loan-status-copy', `Novo credito liberado em ${Math.ceil(state.cooldownRemainingMs / (60 * 60 * 1000))}h.`);
    } else {
        fillText('loan-status-copy', `Limite calculado pelo saldo atual: ${formatMoney(state.dynamicLimit)}.`);
    }

    fillText('loan-next-window', `Disponivel na janela de 24h: ${formatMoney(state.remainingWindowLimit)}.`);
}

function openTransactionDetails(transaction) {
    showTransferReceipt({
        title: 'GLASS BANK',
        subtitle: 'Detalhes da transacao',
        status: transaction.status || 'concluida',
        txId: transaction.txId || formatTransactionId(transaction.id),
        executedAt: timestampToDate(transaction.timestamp, new Date()),
        method: transaction.method || (transaction.type === 'transfer' ? 'Pix' : 'Sistema'),
        senderName: transaction.senderName || 'Sistema',
        senderId: transaction.senderShortId || (transaction.senderId === currentUser?.uid ? currentUser.shortId : transaction.senderId) || '-',
        receiverName: transaction.receiverName || 'Sistema',
        receiverId: transaction.receiverShortId || (transaction.receiverId === currentUser?.uid ? currentUser.shortId : transaction.receiverId) || '-',
        amount: Number(transaction.amount || 0),
        tax: Number(transaction.tax || 0),
        total: Number(transaction.total || (Number(transaction.amount || 0) + Number(transaction.tax || 0)))
    }).catch((error) => {
        logSystemFailure('openTransactionDetails', error, { transactionId: transaction.id }).catch(() => {});
        showToast(toErrorMessage(error), 'error');
    });
}

window.checkNotifications = () => navTo('notifications');

// --- ADMIN FEATURES ---
// Slider Logic
const slider = document.getElementById('tax-slider');
const taxText = document.getElementById('tax-psychology');
const taxValDisplay = document.getElementById('tax-value-display');

if (slider) {
    slider.addEventListener('input', (e) => {
        const val = Number.parseFloat(e.target.value);
        if (taxValDisplay) taxValDisplay.innerText = `${val}%`;
        updateSliderUI(val);
    });
}

function updateSliderUI(val) {
    if (!slider || !taxText || !taxValDisplay) return;
    slider.value = val; // Sync visual
    taxValDisplay.innerText = `${val}%`;
    taxText.className = "";
    if (val <= 0.5) {
        taxText.innerText = "🟢 Sistema Saudável (Quase imperceptível)";
        taxText.classList.add('tax-status-green');
    } else if (val <= 2) {
        taxText.innerText = "🟡 Início de Incômodo (Aceitável)";
        taxText.classList.add('tax-status-yellow');
    } else if (val <= 5) {
        taxText.innerText = "🟠 Risco de Evasão (Perigo)";
        taxText.classList.add('tax-status-orange');
    } else if (val <= 10) {
        taxText.innerText = "🔴 Colapso Funcional (Imposto Disfarçado)";
        taxText.classList.add('tax-status-red');
    } else {
        taxText.innerText = "☠️ Sistema Inviável (Morto)";
        taxText.classList.add('tax-status-black');
    }
}

function initAdminPanel() {
    if (!hasGovernmentAccess()) return;
    updateSliderUI(currentTaxRate * 100);
    const rewardInput = document.getElementById('admin-daily-reward');
    if (rewardInput && document.activeElement !== rewardInput) {
        rewardInput.value = dailyRewardValue.toFixed(2);
    }
    renderTaxVisibility(currentTotalTaxCollected, currentPublicTaxHidden);
}

window.updateGlobalTax = async () => {
    if (!ensureAdmin()) return;
    if (!slider) return;
    const val = Number.parseFloat(slider.value) / 100;
    if (!Number.isFinite(val) || val < 0 || val > 0.15) {
        showToast("Taxa inválida.", "error");
        return;
    }

    try {
        await updateDoc(doc(db, "users", CITY_HALL_ID), { customTax: val });
        showToast("Taxa Atualizada!");
    } catch (e) {
        logSystemFailure('updateGlobalTax', e, { userId: currentUser?.uid, value: val }).catch(() => {});
        showToast(toErrorMessage(e), "error");
    }
};

window.updateDailyReward = async () => {
    if (!ensureAdmin()) return;
    const rewardInput = document.getElementById('admin-daily-reward');
    if (!rewardInput) return;
    const amount = toNumber(rewardInput.value);
    if (!Number.isFinite(amount) || amount <= 0) {
        showToast("Informe um valor válido para o auxílio.", "error");
        return;
    }

    try {
        await updateDoc(doc(db, "users", CITY_HALL_ID), { dailyRewardAmount: amount });
        showToast("Auxílio diário atualizado!");
    } catch (e) {
        logSystemFailure('updateDailyReward', e, { userId: currentUser?.uid, amount }).catch(() => {});
        showToast(toErrorMessage(e), "error");
    }
};

window.togglePublicTaxVisibility = async () => {
    if (!ensureAdmin()) return;

    try {
        await updateDoc(doc(db, "users", CITY_HALL_ID), {
            hidePublicTaxTotal: !currentPublicTaxHidden
        });
        showToast(currentPublicTaxHidden ? "Total publico visivel novamente." : "Total publico ocultado.");
    } catch (error) {
        logSystemFailure('togglePublicTaxVisibility', error, { userId: currentUser?.uid }).catch(() => {});
        showToast(toErrorMessage(error), 'error');
    }
};

window.updateWelfareEligibility = async () => {
    if (!ensureAdmin()) return;
    const shortIdInput = document.getElementById('welfare-target-id');
    const stateInput = document.getElementById('welfare-target-state');
    const statusEl = document.getElementById('welfare-admin-status');
    if (!shortIdInput || !stateInput || !statusEl) return;

    const shortId = shortIdInput.value.trim().toUpperCase();
    const nextEligibility = stateInput.value === 'allow';
    if (!/^[A-Z0-9]{6}$/.test(shortId)) {
        showToast('Informe um ID curto valido.', 'error');
        return;
    }

    try {
        const matches = await getDocs(query(collection(db, "users"), where("shortId", "==", shortId), limit(2)));
        if (matches.empty) throw new Error("Conta nao encontrada.");
        if (matches.size > 1) throw new Error("ID duplicado. Corrija antes de aplicar a regra.");

        const targetDoc = matches.docs[0];
        const targetData = targetDoc.data();
        await updateDoc(targetDoc.ref, {
            welfareEligible: nextEligibility,
            welfareStatusUpdatedAt: serverTimestamp(),
            welfareStatusUpdatedBy: currentUser?.uid || 'SYSTEM'
        });

        shortIdInput.value = '';
        statusEl.innerText = `${targetData.name || 'Conta'} (${shortId}) agora esta ${nextEligibility ? 'liberado para' : 'bloqueado de'} receber auxilio.`;
        showToast(`Auxilio ${nextEligibility ? 'liberado' : 'bloqueado'} para ${targetData.name || shortId}.`);
    } catch (error) {
        logSystemFailure('updateWelfareEligibility', error, { userId: currentUser?.uid, targetShortId: shortId }).catch(() => {});
        showToast(toErrorMessage(error), 'error');
    }
};

window.changeAccountName = async () => {
    if (!currentUser) return;
    const input = document.getElementById('settings-new-name');
    if (!input) return;
    const newName = input.value.trim();
    if (!newName || newName.length < 2) {
        showToast('Nome deve ter pelo menos 2 caracteres.', 'error');
        return;
    }
    if (newName.length > 40) {
        showToast('Nome muito longo (máximo 40 caracteres).', 'error');
        return;
    }
    try {
        await updateDoc(doc(db, "users", currentUser.uid), { name: newName });
        input.value = '';
        showToast('Nome atualizado com sucesso!');
        closeModal('settings-modal');
    } catch (e) {
        logSystemFailure('changeAccountName', e, { userId: currentUser?.uid }).catch(() => {});
        showToast(toErrorMessage(e), 'error');
    }
};

window.changeAccountPassword = async () => {
    if (!currentUser || !auth.currentUser) return;

    const currentPasswordInput = document.getElementById('current-password');
    const newPasswordInput = document.getElementById('new-password');
    const confirmPasswordInput = document.getElementById('confirm-new-password');
    const button = document.getElementById('change-password-btn');
    if (!currentPasswordInput || !newPasswordInput || !confirmPasswordInput || !button) return;

    const currentPassword = currentPasswordInput.value;
    const newPassword = newPasswordInput.value;
    const confirmPassword = confirmPasswordInput.value;
    const remainingMs = getPasswordCooldownRemainingMs(currentUser);

    if (remainingMs > 0) {
        showToast(`Aguarde ${Math.ceil(remainingMs / (60 * 1000))} min para trocar a senha novamente.`, 'error');
        renderPasswordSecurity();
        return;
    }
    if (!currentPassword || !newPassword || !confirmPassword) {
        showToast('Preencha senha atual, nova senha e confirmacao.', 'error');
        return;
    }
    if (newPassword.length < 6) {
        showToast('A nova senha precisa ter pelo menos 6 caracteres.', 'error');
        return;
    }
    if (newPassword !== confirmPassword) {
        showToast('A confirmacao da nova senha nao confere.', 'error');
        return;
    }
    if (!currentUser.email) {
        showToast('Nao foi possivel validar o e-mail desta conta.', 'error');
        return;
    }

    button.disabled = true;
    try {
        const credential = EmailAuthProvider.credential(currentUser.email, currentPassword);
        await reauthenticateWithCredential(auth.currentUser, credential);
        await updatePassword(auth.currentUser, newPassword);

        try {
            await updateDoc(doc(db, "users", currentUser.uid), { lastPasswordChangeAt: serverTimestamp() });
        } catch (cooldownError) {
            setLocalPasswordChangedAt();
            logSystemFailure('changeAccountPassword:cooldown', cooldownError, { userId: currentUser?.uid }).catch(() => {});
            currentPasswordInput.value = '';
            newPasswordInput.value = '';
            confirmPasswordInput.value = '';
            renderPasswordSecurity();
            showToast('Senha alterada. O cooldown ficou salvo apenas neste dispositivo.', 'error');
            return;
        }

        setLocalPasswordChangedAt();

        currentPasswordInput.value = '';
        newPasswordInput.value = '';
        confirmPasswordInput.value = '';
        renderPasswordSecurity();
        showToast('Senha atualizada com sucesso.');
    } catch (error) {
        logSystemFailure('changeAccountPassword', error, { userId: currentUser?.uid }).catch(() => {});
        showToast(toErrorMessage(error), 'error');
    } finally {
        renderPasswordSecurity();
    }
};

window.createPoll = async () => {
    if (!ensureAdmin()) return;
    const title = document.getElementById('poll-title').value.trim();
    const cost = toNumber(document.getElementById('poll-cost').value);
    const target = Number.parseInt(document.getElementById('poll-target').value, 10);

    if (!title) {
        showToast("Informe o título da enquete.", "error");
        return;
    }
    if (!Number.isFinite(cost) || cost <= 0) {
        showToast("Informe um custo válido.", "error");
        return;
    }
    if (!Number.isInteger(target) || target <= 0) {
        showToast("Informe uma meta de votos válida.", "error");
        return;
    }

    try {
        await runTransaction(db, async (t) => {
            const cityRef = doc(db, "users", CITY_HALL_ID);
            const cityDoc = await t.get(cityRef);
            if (!cityDoc.exists()) throw new Error("Prefeitura nao encontrada.");

            const existingPolls = getStoredInvestmentPolls(cityDoc.data());
            const nowMs = Date.now();
            const nextPoll = {
                id: makeInvestmentPollId(existingPolls),
                title,
                cost,
                targetVotes: target,
                votes: 0,
                status: 'open',
                voters: [],
                createdAtMs: nowMs,
                updatedAtMs: nowMs
            };

            t.update(cityRef, {
                investmentPolls: [nextPoll, ...existingPolls].slice(0, MAX_INVESTMENT_POLLS)
            });
        });
        document.getElementById('poll-title').value = "";
        document.getElementById('poll-cost').value = "";
        document.getElementById('poll-target').value = "";
        showToast("Enquete Publicada");
    } catch (e) {
        logSystemFailure('createPoll', e, { userId: currentUser?.uid, title }).catch(() => {});
        showToast(toErrorMessage(e), "error");
    }
};

window.votePoll = async (pollId) => {
    if (!currentUser) return;

    const cityRef = doc(db, "users", CITY_HALL_ID);
    try {
        let voteMessage = "Voto computado!";
        await runTransaction(db, async (t) => {
            const cityDoc = await t.get(cityRef);
            if (!cityDoc.exists()) throw new Error("Prefeitura nao encontrada.");

            const cityData = cityDoc.data();
            const polls = getStoredInvestmentPolls(cityData);
            const pollIndex = polls.findIndex((poll) => poll.id === pollId);
            if (pollIndex < 0) throw new Error("Enquete nao encontrada.");

            const pollData = polls[pollIndex];
            if ((pollData.status || 'open') !== 'open') throw new Error("Esta enquete nao aceita mais votos.");
            const voters = Array.isArray(pollData.voters) ? pollData.voters : [];
            if (voters.includes(currentUser.uid)) throw new Error("Voce ja votou!");

            const newVotes = Number(pollData.votes || 0) + 1;
            const newVoters = [...voters, currentUser.uid];
            let newStatus = 'open';
            const nextPolls = [...polls];

            if (newVotes >= Number(pollData.targetVotes || 0) && cityDoc.exists()) {
                if (Number(cityData.balance || 0) >= Number(pollData.cost || 0)) {
                    newStatus = 'funded';
                    voteMessage = "Meta atingida. Projeto financiado!";
                    const txRef = doc(collection(db, "transactions"));
                    t.set(txRef, buildTransactionRecord(txRef.id, {
                        senderId: CITY_HALL_ID,
                        senderName: 'Prefeitura',
                        senderShortId: 'CITY',
                        receiverId: 'PROJECT',
                        receiverName: pollData.title || 'Projeto publico',
                        receiverShortId: 'POLL',
                        amount: Number(pollData.cost || 0),
                        type: 'poll_fund',
                        method: 'Tesouro',
                        participants: [CITY_HALL_ID]
                    }));
                } else {
                    newStatus = 'aguardando_verba';
                    voteMessage = "Meta atingida. Projeto aguardando verba.";
                }
            }

            nextPolls[pollIndex] = {
                ...pollData,
                votes: newVotes,
                voters: newVoters,
                status: newStatus,
                updatedAtMs: Date.now()
            };

            const cityUpdate = {
                investmentPolls: nextPolls
            };
            if (newStatus === 'funded') {
                cityUpdate.balance = Number(cityData.balance || 0) - Number(pollData.cost || 0);
            }

            t.update(cityRef, cityUpdate);
        });
        showToast(voteMessage);
    } catch (e) {
        logSystemFailure('votePoll', e, { userId: currentUser?.uid, pollId }).catch(() => {});
        showToast(toErrorMessage(e), "error");
    }
};

window.deletePoll = async (pollId) => {
    if (!hasGovernmentAccess()) { showToast('Ação restrita à prefeitura.', 'error'); return; }
    if (!confirm('Remover esta enquete? Esta ação não pode ser desfeita.')) return;
    const cityRef = doc(db, "users", CITY_HALL_ID);
    try {
        await runTransaction(db, async (t) => {
            const cityDoc = await t.get(cityRef);
            if (!cityDoc.exists()) throw new Error("Prefeitura não encontrada.");
            const polls = getStoredInvestmentPolls(cityDoc.data());
            const next = polls.filter((p) => p.id !== pollId);
            if (next.length === polls.length) throw new Error("Enquete não encontrada.");
            t.update(cityRef, { investmentPolls: next });
        });
        showToast('Enquete removida.');
    } catch (e) {
        logSystemFailure('deletePoll', e, { userId: currentUser?.uid, pollId }).catch(() => {});
        showToast(toErrorMessage(e), 'error');
    }
};

window.takeLoan = async () => {
    if (!currentUser) return;
    const input = document.getElementById('loan-amount-input');
    if (!input) return;

    const amount = toNumber(input.value);
    const state = getLoanState(currentUser);
    if (!Number.isFinite(amount) || amount <= 0) {
        showToast("Informe um valor válido.", "error");
        return;
    }
    if (state.accountAgeMinutes < LOAN_MIN_ACCOUNT_MINUTES) {
        showToast("Conta muito nova para emprestimo.", "error");
        return;
    }
    if (state.loanOutstanding > 0) {
        showToast("Quite sua divida atual antes de novo emprestimo.", "error");
        return;
    }
    if (state.cooldownRemainingMs > 0) {
        showToast("Existe um intervalo minimo entre emprestimos.", "error");
        return;
    }
    if (amount > state.availableLimit) {
        showToast(`Limite disponivel agora: ${formatMoney(state.availableLimit)}.`, "error");
        return;
    }
    if (Number(currentUser.balance || 0) < 0) {
        showToast("Quite sua dívida atual antes de novo empréstimo.", "error");
        return;
    }

    try {
        await runTransaction(db, async (t) => {
            const userRef = doc(db, "users", currentUser.uid);
            const userDoc = await t.get(userRef);
            if (!userDoc.exists()) throw new Error("Usuário não encontrado.");
            const userData = userDoc.data();
            const freshState = getLoanState(userData);
            if (Number(userData.balance || 0) < 0) throw new Error("Você já possui saldo negativo.");
            if (freshState.loanOutstanding > 0) throw new Error("Voce ja possui uma divida ativa.");
            if (freshState.accountAgeMinutes < LOAN_MIN_ACCOUNT_MINUTES) throw new Error("Conta nova demais para credito.");
            if (freshState.cooldownRemainingMs > 0) throw new Error("Aguarde o fim do intervalo de credito.");
            if (amount > freshState.availableLimit) throw new Error(`Limite atual: ${formatMoney(freshState.availableLimit)}.`);

            t.update(userRef, {
                balance: increment(amount),
                loanOutstanding: Number((freshState.loanOutstanding + amount).toFixed(2)),
                borrowedThisWindow: freshState.windowActive ? Number((freshState.borrowedThisWindow + amount).toFixed(2)) : amount,
                loanWindowStartedAt: freshState.windowActive ? userData.loanWindowStartedAt : serverTimestamp(),
                lastLoanAt: serverTimestamp(),
                lastDebtInterestDate: serverTimestamp()
            });

            const txRef = doc(collection(db, "transactions"));
            t.set(txRef, buildTransactionRecord(txRef.id, {
                senderId: 'SYSTEM',
                senderName: 'Credito Bancario',
                senderShortId: 'BANK',
                receiverId: currentUser.uid,
                receiverName: currentUser.name,
                receiverShortId: currentUser.shortId || currentUser.uid,
                amount,
                type: 'loan',
                method: 'Credito',
                participants: [currentUser.uid]
            }));
        });

        input.value = "";
        document.getElementById('loan-repay-input').value = "";
        showToast(`Emprestimo aprovado: ${formatMoney(amount)}`);
        navTo('dashboard');
    } catch (e) {
        logSystemFailure('takeLoan', e, { userId: currentUser?.uid, amount }).catch(() => {});
        showToast(toErrorMessage(e), "error");
    }
};

window.repayLoan = async () => {
    if (!currentUser) return;
    const input = document.getElementById('loan-repay-input');
    if (!input) return;

    const requestedAmount = toNumber(input.value);
    const maxPossible = Math.min(Number(currentUser.balance || 0), Number(currentUser.loanOutstanding || 0));
    const amount = Number.isFinite(requestedAmount) && requestedAmount > 0 ? requestedAmount : maxPossible;

    if (!Number.isFinite(amount) || amount <= 0) {
        showToast("Informe um valor valido para amortizar.", "error");
        return;
    }

    try {
        await runTransaction(db, async (t) => {
            const userRef = doc(db, "users", currentUser.uid);
            const userDoc = await t.get(userRef);
            if (!userDoc.exists()) throw new Error("Usuário não encontrado.");

            const userData = userDoc.data();
            const balance = Number(userData.balance || 0);
            const outstanding = Number(userData.loanOutstanding || 0);
            const payment = Math.min(amount, balance, outstanding);

            if (payment <= 0) throw new Error("Sem saldo ou divida suficiente para amortizar.");

            t.update(userRef, {
                balance: Number((balance - payment).toFixed(2)),
                loanOutstanding: Number((outstanding - payment).toFixed(2)),
                lastLoanRepaymentAt: serverTimestamp(),
                lastDebtInterestDate: serverTimestamp()
            });

            const txRef = doc(collection(db, "transactions"));
            t.set(txRef, buildTransactionRecord(txRef.id, {
                senderId: currentUser.uid,
                senderName: currentUser.name,
                senderShortId: currentUser.shortId || currentUser.uid,
                receiverId: 'SYSTEM',
                receiverName: 'Banco Central',
                receiverShortId: 'BANK',
                amount: payment,
                type: 'loan_payment',
                method: 'Debito',
                participants: [currentUser.uid]
            }));
        });

        input.value = "";
        showToast("Amortizacao registrada.");
    } catch (error) {
        logSystemFailure('repayLoan', error, { userId: currentUser?.uid, amount }).catch(() => {});
        showToast(toErrorMessage(error), 'error');
    }
};

// --- QR ---
function buildQrPayload(shortId, amount) {
    return `${QR_PREFIX}:${shortId}:${amount.toFixed(2)}`;
}

function parseQrPayload(text) {
    if (typeof text !== 'string') return null;
    const match = text.trim().match(/^GBANK:([A-Z0-9]{6}):(\d+(?:[.,]\d{1,2})?)$/i);
    if (!match) return null;

    const amount = toNumber(match[2]);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return { shortId: match[1].toUpperCase(), amount };
}

function generateQR() {
    const amountInput = document.getElementById('qr-amount');
    const image = document.getElementById('qr-image');
    if (!amountInput || !image || !currentUser?.shortId) return;

    const amount = toNumber(amountInput.value);
    if (!Number.isFinite(amount) || amount <= 0) {
        image.style.display = 'none';
        image.removeAttribute('src');
        return;
    }

    const payload = buildQrPayload(currentUser.shortId, amount);
    image.src = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(payload)}`;
    image.style.display = 'block';
}
window.generateQR = generateQR;

async function startScanner() {
    if (scannerIsRunning) return;
    if (!window.Html5Qrcode) {
        showToast("Leitor de QR indisponível.", "error");
        return;
    }

    try {
        if (!html5QrcodeScanner) html5QrcodeScanner = new window.Html5Qrcode("reader");

        await html5QrcodeScanner.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 220, height: 220 } },
            async (decodedText) => {
                const payload = parseQrPayload(decodedText);
                if (!payload) return;
                if (payload.shortId === currentUser?.shortId) {
                    showToast("Este QR pertence à sua própria conta.", "error");
                    return;
                }

                await stopScanner();
                navTo('transfer');
                document.getElementById('dest-id').value = payload.shortId;
                document.getElementById('amount').value = payload.amount.toFixed(2);
                updateTransferPreview();
                showToast("QR lido com sucesso.");
            },
            () => {}
        );

        scannerIsRunning = true;
    } catch (e) {
        showToast("Não foi possível iniciar a câmera.", "error");
    }
}

async function stopScanner() {
    if (!html5QrcodeScanner) return;
    try {
        if (scannerIsRunning) {
            await html5QrcodeScanner.stop();
            await html5QrcodeScanner.clear();
        }
    } catch (_) {
        // Ignora erros de parada do scanner.
    } finally {
        scannerIsRunning = false;
    }
}

// --- TRANSAÇÕES ---
function updateTransferPreview() {
    const amountInput = document.getElementById('amount');
    const taxDisplay = document.getElementById('tax-display');
    const totalDebit = document.getElementById('total-debit');
    if (!amountInput || !taxDisplay || !totalDebit) return;

    const amount = toNumber(amountInput.value);
    const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;
    const total = safeAmount + (safeAmount * currentTaxRate);

    taxDisplay.innerText = `${(currentTaxRate * 100).toFixed(1)}%`;
    totalDebit.innerText = formatMoney(total);
}

async function showTransferReceipt(data) {
    const modal = document.getElementById('receipt-modal');
    if (!modal) return;

    const executedAt = data.executedAt || new Date();
    const authCode = await buildReceiptAuthCode({
        txId: data.txId,
        method: data.method,
        senderId: data.senderId,
        receiverId: data.receiverId,
        amount: data.amount,
        tax: data.tax,
        total: data.total,
        executedAt: executedAt.toISOString()
    });

    fillText('receipt-title', data.title || 'GLASS BANK');
    fillText('receipt-subtitle', data.subtitle || 'Comprovante de Transacao');
    fillText('rcpt-amount', formatMoney(data.amount));
    fillText('rcpt-tax', formatMoney(data.tax));
    fillText('rcpt-total', formatMoney(data.total));
    fillText('rcpt-status', formatStatus(data.status || 'concluida'));
    fillText('rcpt-txid', data.txId || '-');
    fillText('rcpt-date', formatDateTime(executedAt));
    fillText('rcpt-method', data.method || 'Pix');
    fillText('rcpt-sender', data.senderName || '-');
    fillText('rcpt-sender-id', data.senderId || '-');
    fillText('rcpt-receiver', data.receiverName || '-');
    fillText('rcpt-receiver-id', data.receiverId || '-');
    fillText('rcpt-auth', authCode);

    modal.classList.remove('hidden');
}

window.executeTransaction = async (shortId, amount) => transferLogic(shortId, amount);

async function transferLogic(shortId, amount) {
    if (!currentUser) return false;

    const receiverShortId = String(shortId || '').toUpperCase().trim();
    const transferAmount = Number(amount);

    if (!/^[A-Z0-9]{6}$/.test(receiverShortId)) {
        showToast("ID do destinatário inválido.", "error");
        return false;
    }
    if (!Number.isFinite(transferAmount) || transferAmount <= 0) {
        showToast("Valor inválido.", "error");
        return false;
    }

    try {
        const q = query(collection(db, "users"), where("shortId", "==", receiverShortId));
        const receiverSnap = await getDocs(q);
        if (receiverSnap.empty) throw new Error("Destinatário não encontrado.");
        if (receiverSnap.size > 1) throw new Error("ID do destinatário duplicado. Contate o suporte.");

        const receiverUid = receiverSnap.docs[0].id;
        if (receiverUid === currentUser.uid) throw new Error("Erro: mesmo usuário.");
        let receiverName = 'Destinatário';
        let receiptTax = 0;
        let receiptTotal = 0;
        let receiptTxId = '';
        let receiptExecutedAt = new Date();

        await runTransaction(db, async (t) => {
            const senderRef = doc(db, "users", currentUser.uid);
            const receiverRef = doc(db, "users", receiverUid);
            const cityRef = doc(db, "users", CITY_HALL_ID);

            const sDoc = await t.get(senderRef);
            const rDoc = await t.get(receiverRef);
            const cDoc = await t.get(cityRef);
            if (!sDoc.exists() || !rDoc.exists()) throw new Error("Conta não encontrada.");

            receiverName = rDoc.data().name || 'Destinatário';
            const taxRate = cDoc.exists() ? Number(cDoc.data().customTax || 0.02) : 0.02;
            const tax = Number((transferAmount * taxRate).toFixed(2));
            const total = Number((transferAmount + tax).toFixed(2));
            receiptTax = tax;
            receiptTotal = total;
            receiptExecutedAt = new Date();

            if (Number(sDoc.data().balance || 0) < total) throw new Error("Saldo insuficiente.");

            t.update(senderRef, { balance: increment(-total) });
            t.update(receiverRef, { balance: increment(transferAmount) });
            if (cDoc.exists()) {
                t.update(cityRef, {
                    balance: increment(tax),
                    totalTaxCollected: increment(tax)
                });
            }

            const txRef = doc(collection(db, "transactions"));
            receiptTxId = formatTransactionId(txRef.id);
            t.set(txRef, buildTransactionRecord(txRef.id, {
                senderId: currentUser.uid,
                senderName: currentUser.name,
                senderShortId: currentUser.shortId || currentUser.uid,
                receiverId: receiverUid,
                receiverName: receiverName,
                receiverShortId: receiverShortId,
                amount: transferAmount,
                tax,
                total,
                type: 'transfer',
                method: 'Pix',
                participants: [currentUser.uid, receiverUid]
            }));
        });

        try {
            await saveContactUsage(receiverShortId, receiverName);
        } catch (contactError) {
            logSystemFailure('saveContactUsage', contactError, { userId: currentUser?.uid, receiverShortId }).catch(() => {});
        }
        showToast("Transferência realizada!");
        navTo('dashboard');
        document.getElementById('transfer-form').reset();
        updateTransferPreview();
        await showTransferReceipt({
            title: 'GLASS BANK',
            subtitle: 'Comprovante de Transacao',
            status: 'concluida',
            txId: receiptTxId,
            executedAt: receiptExecutedAt,
            method: 'Pix',
            senderName: currentUser.name,
            senderId: currentUser.shortId || currentUser.uid,
            receiverName: receiverName,
            receiverId: receiverShortId,
            amount: transferAmount,
            tax: receiptTax,
            total: receiptTotal
        });
        return true;
    } catch (e) {
        logSystemFailure('transferLogic', e, {
            userId: currentUser?.uid,
            receiverShortId,
            amount: transferAmount
        }).catch(() => {});
        showToast(toErrorMessage(e), 'error');
        return false;
    }
}

document.getElementById('transfer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('dest-id').value.toUpperCase().trim();
    const amt = toNumber(document.getElementById('amount').value);
    if (!/^[A-Z0-9]{6}$/.test(id)) return showToast("ID do destinatário inválido.", "error");
    if (!Number.isFinite(amt) || amt <= 0) return showToast("Valor inválido.", "error");
    if (id === currentUser?.shortId) return showToast("Você não pode transferir para si mesmo.", "error");

    const tax = Number((amt * currentTaxRate).toFixed(2));
    const total = Number((amt + tax).toFixed(2));
    const balanceAfter = Number(((currentUser?.balance || 0) - total).toFixed(2));

    // Populate confirmation modal
    const el = (selector) => document.getElementById(selector);
    if (el('confirm-dest-id'))    el('confirm-dest-id').innerText    = id;
    if (el('confirm-amount'))     el('confirm-amount').innerText     = formatMoney(amt);
    if (el('confirm-tax'))        el('confirm-tax').innerText        = formatMoney(tax);
    if (el('confirm-total'))      el('confirm-total').innerText      = formatMoney(total);
    if (el('confirm-balance-after')) {
        el('confirm-balance-after').innerText = formatMoney(balanceAfter);
        el('confirm-balance-after').style.color = balanceAfter < 0 ? 'var(--red)' : 'var(--green)';
    }

    pendingTransaction = { id, amt };
    el('transfer-confirm-modal')?.classList.remove('hidden');
});

document.getElementById('confirm-pin-btn').addEventListener('click', async () => {
    if (!pendingTransaction || !currentUser) {
        showToast("Nenhuma transação pendente.", "error");
        return;
    }

    const pinInput = document.getElementById('confirm-pin-input').value;
    if (pinInput.length < 4) { showToast("PIN incompleto.", "error"); return; }
    if (await verifyAndMigratePin(currentUser, pinInput)) {
        const ok = await transferLogic(pendingTransaction.id, pendingTransaction.amt);
        if (ok) closeModal('pin-modal');
    } else {
        showToast("PIN Incorreto", "error");
    }
});

// --- HISTÓRICO & FILTROS ---
function listenToTransactions(uid) {
    if (unsubTransactions) unsubTransactions();
    const q = query(collection(db, "transactions"), where("participants", "array-contains", uid), orderBy("timestamp", "desc"), limit(50));
    unsubTransactions = onSnapshot(q, (snap) => {
        currentTransactions = [];
        snap.forEach(d => currentTransactions.push({ ...d.data(), id: d.id }));
        renderHistory(activeHistoryFilter);
        renderNotifications();
    });
}

window.filterHistory = (filter, event) => {
    activeHistoryFilter = filter;
    document.querySelectorAll('.filter-chips button').forEach(b => b.classList.remove('active-chip'));
    const targetBtn = event?.currentTarget || document.querySelector(`.filter-chips button[data-filter="${filter}"]`);
    if (targetBtn) targetBtn.classList.add('active-chip');
    renderHistory(filter);
};

function renderHistory(filter) {
    const list = document.getElementById('transaction-list');
    if (!list || !currentUser) return;
    list.innerHTML = "";
    let rendered = 0;

    currentTransactions.forEach(t => {
        const isSender = t.senderId === currentUser.uid;
        const hasTax = Number(t.tax || 0) > 0 || t.type === 'tax';
        if (filter === 'in' && isSender) return;
        if (filter === 'out' && !isSender) return;
        if (filter === 'tax' && !hasTax) return;

        const li = document.createElement('li');
        let icon = isSender ? 'arrow-up' : 'arrow-down';
        let color = isSender ? '#ff416c' : '#00f260';
        let signal = isSender ? '-' : '+';

        if (t.type === 'interest_loan' || t.type === 'interest_overdraft') { icon = 'fire'; color = '#e74c3c'; signal = '-'; }
        if (t.type === 'interest_yield') { icon = 'leaf'; color = '#f1c40f'; signal = '+'; }
        if (t.type === 'welfare') { icon = 'gift'; color = '#3498db'; signal = '+'; }
        if (t.type === 'loan') { icon = 'hand-holding-usd'; color = '#f39c12'; signal = '+'; }
        if (t.type === 'loan_payment') { icon = 'wallet'; color = '#ff9f43'; signal = '-'; }

        const title = t.type === 'transfer' ? (isSender ? t.receiverName : t.senderName) : (t.senderName || 'Sistema');
        const txType = String(t.type || 'transaction').toUpperCase();
        const executedAt = timestampToDate(t.timestamp, new Date(0));

        const main = document.createElement('div');
        main.className = 'history-main';

        const left = document.createElement('div');
        left.className = 'history-left';
        const iconEl = document.createElement('i');
        iconEl.className = `fas fa-${icon}`;
        iconEl.style.color = color;
        iconEl.style.marginRight = '10px';

        const copy = document.createElement('div');
        copy.className = 'history-copy';
        const strong = document.createElement('strong');
        strong.textContent = String(title || 'Sistema');

        const small = document.createElement('small');
        small.textContent = txType;

        const meta = document.createElement('div');
        meta.className = 'history-meta';

        const dateMeta = document.createElement('span');
        dateMeta.textContent = formatDateTime(executedAt);

        const txMeta = document.createElement('span');
        txMeta.textContent = t.txId || formatTransactionId(t.id);

        meta.appendChild(dateMeta);
        meta.appendChild(txMeta);

        copy.appendChild(strong);
        copy.appendChild(small);
        copy.appendChild(meta);

        if (hasTax) {
            const taxLine = document.createElement('small');
            taxLine.className = 'history-tax';
            taxLine.textContent = `Imposto: ${formatMoney(t.tax || 0)}`;
            copy.appendChild(taxLine);
        }

        left.appendChild(iconEl);
        left.appendChild(copy);

        const right = document.createElement('div');
        right.className = 'history-right';
        right.style.color = color;
        right.textContent = `${signal} ${formatMoney(t.amount || 0)}`;

        const status = document.createElement('span');
        status.className = `status-pill ${t.status === 'estornada' ? 'estornada' : 'concluida'}`;
        status.textContent = formatStatus(t.status || 'concluida');

        main.appendChild(left);
        main.appendChild(right);
        li.appendChild(main);
        li.appendChild(status);
        li.addEventListener('click', () => openTransactionDetails(t));
        list.appendChild(li);
        rendered += 1;
    });

    if (!rendered) {
        renderEmptyState(list, 'Nenhuma transacao encontrada neste filtro.');
    }
}

function initStaticListeners() {
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn && !logoutBtn.dataset.bound) {
        logoutBtn.dataset.bound = '1';
        logoutBtn.addEventListener('click', async () => {
            try {
                await signOut(auth);
            } catch (e) {
                showToast(toErrorMessage(e), 'error');
            }
        });
    }

    const amountInput = document.getElementById('amount');
    if (amountInput && !amountInput.dataset.bound) {
        amountInput.dataset.bound = '1';
        amountInput.addEventListener('input', updateTransferPreview);
    }

    const pinInput = document.getElementById('confirm-pin-input');
    if (pinInput && !pinInput.dataset.bound) {
        pinInput.dataset.bound = '1';
        pinInput.addEventListener('input', () => {
            pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 6);
        });
    }

    const welfareTargetInput = document.getElementById('welfare-target-id');
    if (welfareTargetInput && !welfareTargetInput.dataset.bound) {
        welfareTargetInput.dataset.bound = '1';
        welfareTargetInput.addEventListener('input', () => {
            welfareTargetInput.value = welfareTargetInput.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 6);
        });
    }
}

toggleAuth('login');
updateTransferPreview();














