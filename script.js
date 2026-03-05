import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js";
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

const CITY_HALL_ID = "vTFqk1ZX8NfwzuE4ZmJKXnfoI9r1";
const QR_PREFIX = "GBANK";
const LOAN_LIMIT = 5000;

const toErrorMessage = (error) => {
    if (typeof error === 'string') return error;
    if (error && typeof error.message === 'string') return error.message;
    return 'Ocorreu um erro inesperado.';
};

const toNumber = (value) => Number.parseFloat(String(value).replace(',', '.'));
const formatMoney = (value) => `R$ ${Number(value || 0).toFixed(2)}`;
const timestampToDate = (timestamp, fallback = new Date(0)) => {
    return timestamp && typeof timestamp.toDate === 'function' ? timestamp.toDate() : fallback;
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

function ensureAdmin() {
    if (currentUser?.role !== 'admin') {
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

function cleanupListeners() {
    if (unsubUser) unsubUser();
    if (unsubTransactions) unsubTransactions();
    if (unsubCity) unsubCity();
    if (unsubPolls) unsubPolls();
    unsubUser = null;
    unsubTransactions = null;
    unsubCity = null;
    unsubPolls = null;
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
    toast.style.cssText = `background: ${type==='error'?'#ff416c':'#00f260'}; color:${type==='error'?'white':'black'}; padding:15px; margin-bottom:10px; border-radius:10px; box-shadow:0 5px 15px rgba(0,0,0,0.3); animation: slideUp 0.3s;`;
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
            if (!/^\d{4}$/.test(pin)) throw new Error("PIN deve ter 4 números.");
            if (!allowedRoles.has(role)) throw new Error("Tipo de conta inválido.");

            const userCred = await createUserWithEmailAndPassword(auth, email, password);
            const shortId = await generateUniqueShortId();
            const { pinHash, pinSalt } = await makePinHash(pin);
            // Criação do documento do usuário
            await setDoc(doc(db, "users", userCred.user.uid), {
                name: name, email: email, role: role, pinHash, pinSalt,
                shortId: shortId,
                balance: 1000.00,
                savingsBalance: 0, // NOVO: Poupança
                stocks: { glasscoin: 0 }, // NOVO: Ações
                lastDailyClaim: null, // NOVO: Auxílio
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
        loanBadge.style.display = balance < 0 ? 'inline-block' : 'none';

        checkDailyRewardStatus();
        updateTransferPreview();
        generateQR();

        if (currentUser.role === 'admin') {
            document.getElementById('admin-btn').classList.remove('hidden');
            initAdminPanel();
        } else {
            document.getElementById('admin-btn').classList.add('hidden');
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
    if (Number(currentUser.balance || 0) < 0 && debtIntervals > 0) {
        const currentDebt = Number(currentUser.balance || 0);
        const newDebt = currentDebt * Math.pow(1.05, debtIntervals);
        const interestAmount = Math.abs(newDebt - currentDebt);

        await runTransaction(db, async (t) => {
            const userRef = doc(db, "users", uid);
            t.update(userRef, {
                balance: newDebt,
                lastInterestDate: serverTimestamp(),
                lastDebtInterestDate: serverTimestamp()
            });
            const txRef = doc(collection(db, "transactions"));
            t.set(txRef, {
                senderId: 'SYSTEM', senderName: 'Banco Central',
                receiverId: uid, receiverName: currentUser.name,
                amount: interestAmount, type: 'interest_debt',
                timestamp: serverTimestamp(), participants: [uid]
            });
        });
        showToast(`Juros de Dívida aplicados: ${formatMoney(interestAmount)}`, 'error');
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

        await addDoc(collection(db, "transactions"), {
            senderId: 'SYSTEM', senderName: 'Cofre Rendimento',
            receiverId: uid, receiverName: currentUser.name,
            amount: yieldAmount, type: 'interest_yield',
            timestamp: serverTimestamp(), participants: [uid]
        });
        showToast(`Rendimento da Poupança: +${formatMoney(yieldAmount)}`);
    }
}

// --- SISTEMA PREFEITURA & TRANSPARÊNCIA ---
function syncSystemData() {
    if (unsubCity) unsubCity();
    if (unsubPolls) unsubPolls();

    unsubCity = onSnapshot(doc(db, "users", CITY_HALL_ID), (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        currentTaxRate = Number(data.customTax || 0.02);
        dailyRewardValue = Number(data.dailyRewardAmount || 50);

        document.getElementById('city-hall-balance').innerText = formatMoney(data.balance || 0);
        document.getElementById('total-tax-collected').innerText = formatMoney(data.totalTaxCollected || 0);
        document.getElementById('tax-display').innerText = `${(currentTaxRate * 100).toFixed(1)}%`;
        updateTransferPreview();

        if (currentUser?.role === 'admin') {
            updateSliderUI(currentTaxRate * 100);
            const rewardInput = document.getElementById('admin-daily-reward');
            if (rewardInput && document.activeElement !== rewardInput) {
                rewardInput.value = dailyRewardValue.toFixed(2);
            }
        }
    });

    const q = query(collection(db, "polls"), where("status", "==", "open"));
    unsubPolls = onSnapshot(q, (snap) => {
        const list = document.getElementById('polls-list');
        if (!list) return;
        list.innerHTML = "";

        snap.forEach(docSnap => {
            const p = docSnap.data();
            const votes = Number(p.votes || 0);
            const targetVotes = Math.max(1, Number(p.targetVotes || 1));
            const cost = Number(p.cost || 0);
            const percent = Math.min(100, (votes / targetVotes) * 100);

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

            const voteBtn = document.createElement('button');
            voteBtn.textContent = 'Votar';
            voteBtn.style.width = 'auto';
            voteBtn.style.padding = '5px 15px';
            voteBtn.style.margin = '0';
            voteBtn.addEventListener('click', () => window.votePoll(docSnap.id));

            rowBottom.appendChild(votesSmall);
            rowBottom.appendChild(voteBtn);

            div.appendChild(rowTop);
            div.appendChild(progress);
            div.appendChild(rowBottom);
            list.appendChild(div);
        });
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
    if (!area) return;
    const now = new Date();
    const last = timestampToDate(currentUser.lastDailyClaim, new Date(0));
    const diffHours = (now - last) / (1000 * 60 * 60);

    if (diffHours >= 24) {
        area.classList.remove('hidden');
    } else {
        area.classList.add('hidden');
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
            t.set(txRef, {
                senderId: CITY_HALL_ID, senderName: "Prefeitura (Auxílio)",
                receiverId: currentUser.uid, receiverName: currentUser.name,
                amount: dailyRewardValue, type: 'welfare',
                timestamp: serverTimestamp(), participants: [currentUser.uid, CITY_HALL_ID]
            });
        });
        showToast(`Recebeu ${formatMoney(dailyRewardValue)}!`);
        document.getElementById('daily-reward-area').classList.add('hidden');
    } catch(e) { showToast(toErrorMessage(e), 'error'); }
};

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
    if (currentUser?.role !== 'admin') return;
    updateSliderUI(currentTaxRate * 100);
    const rewardInput = document.getElementById('admin-daily-reward');
    if (rewardInput && document.activeElement !== rewardInput) {
        rewardInput.value = dailyRewardValue.toFixed(2);
    }
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
        showToast(toErrorMessage(e), "error");
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
        await addDoc(collection(db, "polls"), {
            title, cost, targetVotes: target, votes: 0, status: 'open', voters: []
        });
        document.getElementById('poll-title').value = "";
        document.getElementById('poll-cost').value = "";
        document.getElementById('poll-target').value = "";
        showToast("Enquete Publicada");
    } catch (e) {
        showToast(toErrorMessage(e), "error");
    }
};

window.votePoll = async (pollId) => {
    if (!currentUser) return;

    const pollRef = doc(db, "polls", pollId);
    try {
        await runTransaction(db, async (t) => {
            const pDoc = await t.get(pollRef);
            if (!pDoc.exists()) throw new Error("Enquete não encontrada.");

            const pollData = pDoc.data();
            const voters = Array.isArray(pollData.voters) ? pollData.voters : [];
            if (voters.includes(currentUser.uid)) throw new Error("Você já votou!");

            const cityRef = doc(db, "users", CITY_HALL_ID);
            const cityDoc = await t.get(cityRef);

            const newVotes = Number(pollData.votes || 0) + 1;
            const newVoters = [...voters, currentUser.uid];
            let newStatus = 'open';

            if (newVotes >= Number(pollData.targetVotes || 0) && cityDoc.exists()) {
                if (Number(cityDoc.data().balance || 0) >= Number(pollData.cost || 0)) {
                    t.update(cityRef, { balance: increment(-Number(pollData.cost || 0)) });
                    newStatus = 'funded';
                }
            }

            t.update(pollRef, { votes: newVotes, voters: newVoters, status: newStatus });
        });
        showToast("Voto computado!");
    } catch (e) {
        showToast(toErrorMessage(e), "error");
    }
};

window.checkNotifications = () => {
    if (!currentUser) return;
    if (!currentTransactions.length) {
        showToast("Sem notificações novas.");
        return;
    }

    const tx = currentTransactions[0];
    const isSender = tx.senderId === currentUser.uid;
    const name = tx.type === 'transfer' ? (isSender ? tx.receiverName : tx.senderName) : (tx.senderName || 'Sistema');
    showToast(`${(tx.type || 'transaction').toUpperCase()} • ${name} • ${formatMoney(tx.amount || 0)}`);
};

window.takeLoan = async () => {
    if (!currentUser) return;
    const input = document.getElementById('loan-amount-input');
    if (!input) return;

    const amount = toNumber(input.value);
    if (!Number.isFinite(amount) || amount <= 0) {
        showToast("Informe um valor válido.", "error");
        return;
    }
    if (amount > LOAN_LIMIT) {
        showToast(`Limite máximo por solicitação: ${formatMoney(LOAN_LIMIT)}.`, "error");
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
            if (Number(userDoc.data().balance || 0) < 0) throw new Error("Você já possui dívida ativa.");

            t.update(userRef, {
                balance: increment(amount),
                lastDebtInterestDate: serverTimestamp()
            });

            const txRef = doc(collection(db, "transactions"));
            t.set(txRef, {
                senderId: 'SYSTEM', senderName: 'Crédito Bancário',
                receiverId: currentUser.uid, receiverName: currentUser.name,
                amount: amount, type: 'loan',
                timestamp: serverTimestamp(), participants: [currentUser.uid]
            });
        });

        input.value = "";
        showToast(`Empréstimo aprovado: ${formatMoney(amount)}`);
        navTo('dashboard');
    } catch (e) {
        showToast(toErrorMessage(e), "error");
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

    fillText('rcpt-amount', formatMoney(data.amount));
    fillText('rcpt-tax', formatMoney(data.tax));
    fillText('rcpt-total', formatMoney(data.total));
    fillText('rcpt-txid', data.txId || '-');
    fillText('rcpt-date', new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(executedAt));
    fillText('rcpt-method', data.method || 'Pix');
    fillText('rcpt-sender', data.senderName || '-');
    fillText('rcpt-sender-id', data.senderId || '-');
    fillText('rcpt-receiver', data.receiverName || '-');
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
            t.set(txRef, {
                senderId: currentUser.uid, senderName: currentUser.name,
                receiverId: receiverUid, receiverName: receiverName,
                amount: transferAmount, tax: tax, type: 'transfer',
                timestamp: serverTimestamp(), participants: [currentUser.uid, receiverUid]
            });
        });

        showToast("Transferência realizada!");
        navTo('dashboard');
        document.getElementById('transfer-form').reset();
        updateTransferPreview();
        await showTransferReceipt({
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
        showToast(toErrorMessage(e), 'error');
        return false;
    }
}

document.getElementById('transfer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = document.getElementById('dest-id').value.toUpperCase().trim();
    const amt = toNumber(document.getElementById('amount').value);
    if (!/^[A-Z0-9]{6}$/.test(id)) return showToast("ID do destinatário inválido.", "error");
    if (!Number.isFinite(amt) || amt <= 0) return showToast("Valor inválido.", "error");

    pendingTransaction = { id, amt };
    document.getElementById('pin-modal').classList.remove('hidden');
    document.getElementById('confirm-pin-input').value = "";
});

document.getElementById('confirm-pin-btn').addEventListener('click', async () => {
    if (!pendingTransaction || !currentUser) {
        showToast("Nenhuma transação pendente.", "error");
        return;
    }

    const pinInput = document.getElementById('confirm-pin-input').value;
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
    const q = query(collection(db, "transactions"), where("participants", "array-contains", uid), orderBy("timestamp", "desc"), limit(30));
    unsubTransactions = onSnapshot(q, (snap) => {
        currentTransactions = [];
        snap.forEach(d => currentTransactions.push({ ...d.data(), id: d.id }));
        renderHistory('all');
    });
}

window.filterHistory = (filter, event) => {
    document.querySelectorAll('.filter-chips button').forEach(b => b.classList.remove('active-chip'));
    const targetBtn = event?.currentTarget || document.querySelector(`.filter-chips button[data-filter="${filter}"]`);
    if (targetBtn) targetBtn.classList.add('active-chip');
    renderHistory(filter);
};

function renderHistory(filter) {
    const list = document.getElementById('transaction-list');
    if (!list || !currentUser) return;
    list.innerHTML = "";

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

        if (t.type === 'interest_debt') { icon = 'fire'; color = '#e74c3c'; signal = '-'; }
        if (t.type === 'interest_yield') { icon = 'leaf'; color = '#f1c40f'; signal = '+'; }
        if (t.type === 'welfare') { icon = 'gift'; color = '#3498db'; signal = '+'; }
        if (t.type === 'loan') { icon = 'hand-holding-usd'; color = '#f39c12'; signal = '+'; }

        const title = t.type === 'transfer' ? (isSender ? t.receiverName : t.senderName) : (t.senderName || 'Sistema');
        const txType = String(t.type || 'transaction').toUpperCase();

        const left = document.createElement('div');
        const iconEl = document.createElement('i');
        iconEl.className = `fas fa-${icon}`;
        iconEl.style.color = color;
        iconEl.style.marginRight = '10px';

        const strong = document.createElement('strong');
        strong.textContent = String(title || 'Sistema');

        const br = document.createElement('br');
        const small = document.createElement('small');
        small.style.opacity = '0.6';
        small.textContent = txType;

        left.appendChild(iconEl);
        left.appendChild(strong);
        left.appendChild(br);
        left.appendChild(small);

        const right = document.createElement('div');
        right.style.color = color;
        right.textContent = `${signal} ${formatMoney(t.amount || 0)}`;

        li.appendChild(left);
        li.appendChild(right);
        list.appendChild(li);
    });
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
            pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 4);
        });
    }
}

toggleAuth('login');
updateTransferPreview();














