import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, updateDoc, collection, query, where, onSnapshot, runTransaction, serverTimestamp, orderBy, limit, getDocs, increment, addDoc } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";

// CONFIGURAÇÃO FIREBASE (MANTENHA A SUA, MAS RESTRINJA NO GOOGLE CLOUD CONSOLE)
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
let pendingTransaction = null; 
let currentTransactions = [];
const CITY_HALL_ID = "vTFqk1ZX8NfwzuE4ZmJKXnfoI9r1";

// --- SONS & UI ---
const playSound = (type) => {
    const id = type === 'success' ? 'snd-success' : type === 'error' ? 'snd-error' : 'snd-click';
    const audio = document.getElementById(id);
    if(audio) { audio.currentTime = 0; audio.play().catch(() => {}); }
};

const showToast = (msg, type = 'success') => {
    playSound(type);
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.style.cssText = `background: ${type==='error'?'#ff416c':'#00f260'}; color:${type==='error'?'white':'black'}; padding:15px; margin-bottom:10px; border-radius:10px; box-shadow:0 5px 15px rgba(0,0,0,0.3); animation: slideUp 0.3s; z-index: 1000; position: relative;`;
    toast.innerText = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
};

window.navTo = (sectionId) => {
    playSound('click');
    document.querySelectorAll('section').forEach(s => {
        s.classList.remove('active-section');
        s.classList.add('hidden');
    });
    
    const target = document.getElementById(sectionId + '-section');
    if(target) {
        target.classList.remove('hidden');
        target.classList.add('active-section');
    }
    
    if(sectionId === 'qr-scan') window.startScanner();
    else window.stopScanner();
};

window.closeModal = (id) => { 
    document.getElementById(id).classList.add('hidden'); 
    pendingTransaction = null; 
};

window.toggleAuth = (mode) => {
    const isReg = mode === 'register';
    document.getElementById('fullname').style.display = isReg ? 'block' : 'none';
    document.getElementById('role-select').style.display = isReg ? 'block' : 'none';
    document.getElementById('reg-pin').style.display = isReg ? 'block' : 'none';
    document.getElementById('auth-btn').innerText = isReg ? 'Cadastrar' : 'Entrar';
    document.getElementById('auth-form').dataset.mode = mode;
};

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
            const name = document.getElementById('fullname').value;
            const role = document.getElementById('role-select').value;
            const pin = document.getElementById('reg-pin').value;
            if(pin.length !== 4) throw new Error("PIN deve ter 4 números.");

            const userCred = await createUserWithEmailAndPassword(auth, email, password);
            await setDoc(doc(db, "users", userCred.user.uid), {
                name: name, email: email, role: role, pin: pin,
                shortId: Math.random().toString(36).substring(2, 8).toUpperCase(),
                balance: 1000.00,
                savingsBalance: 0,
                stocks: { glasscoin: 0 },
                lastDailyClaim: null,
                status: 'active',
                lastInterestDate: serverTimestamp(),
                createdAt: serverTimestamp()
            });
            showToast("Bem-vindo ao GlassBank!");
        } else {
            await signInWithEmailAndPassword(auth, email, password);
        }
    } catch (err) { 
        showToast(err.message, 'error'); 
    } finally { 
        btn.disabled = false; 
        btn.innerText = mode==='register'?'Cadastrar':'Entrar'; 
    }
});

// LOGOUT CORRIGIDO
document.getElementById('logout-btn').addEventListener('click', () => {
    signOut(auth).then(() => {
        showToast("Desconectado com sucesso.");
    });
});

onAuthStateChanged(auth, (user) => {
    if (user) {
        document.getElementById('auth-section').classList.remove('active-section');
        navTo('dashboard');
        initializeUser(user.uid);
    } else {
        navTo('auth');
        currentUser = null;
    }
});

function initializeUser(uid) {
    onSnapshot(doc(db, "users", uid), async (docSnap) => {
        if (docSnap.exists()) {
            currentUser = docSnap.data();
            currentUser.uid = uid;

            if(currentUser.status === 'banned') { signOut(auth); alert("Conta Banida"); return; }

            document.getElementById('user-name').innerText = currentUser.name;
            document.getElementById('user-role').innerText = currentUser.role === 'admin' ? 'Prefeitura' : 'Cidadão';
            document.getElementById('user-balance').innerText = `R$ ${currentUser.balance.toFixed(2)}`;
            document.getElementById('user-short-id').innerText = currentUser.shortId;
            document.getElementById('user-avatar').src = `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.name)}&background=random&color=fff`;
            
            document.getElementById('savings-balance').innerText = `R$ ${(currentUser.savingsBalance || 0).toFixed(2)}`;
            document.getElementById('user-stock-count').innerText = currentUser.stocks?.glasscoin || 0;

            const loanBadge = document.getElementById('loan-indicator');
            loanBadge.style.display = currentUser.balance < 0 ? 'inline-block' : 'none';

            checkDailyRewardStatus();

            if(currentUser.role === 'admin' || uid === CITY_HALL_ID) {
                document.getElementById('admin-btn').classList.remove('hidden');
                window.initAdminPanel();
            }

            processInterests(uid);
        }
    });

    listenToTransactions(uid);
    syncSystemData();
    initStockMarket();
}

async function processInterests(uid) {
    if (!currentUser.lastInterestDate) return;
    const now = new Date();
    const lastCalc = currentUser.lastInterestDate.toDate();
    const diffMinutes = (now - lastCalc) / (1000 * 60);

    if (currentUser.balance < 0 && diffMinutes >= 10) {
        const intervals = Math.floor(diffMinutes / 10);
        const newDebt = currentUser.balance * Math.pow(1.05, intervals);
        const interestAmount = Math.abs(newDebt - currentUser.balance);

        await runTransaction(db, async (t) => {
            const userRef = doc(db, "users", uid);
            t.update(userRef, { balance: newDebt, lastInterestDate: serverTimestamp() });
            const txRef = doc(collection(db, "transactions"));
            t.set(txRef, {
                senderId: 'SYSTEM', senderName: 'Banco Central',
                receiverId: uid, receiverName: currentUser.name,
                amount: interestAmount, type: 'interest_debt',
                timestamp: serverTimestamp(), participants: [uid]
            });
        });
        showToast(`Juros de Dívida aplicados: R$ ${interestAmount.toFixed(2)}`, 'error');
    }

    if (currentUser.savingsBalance > 0 && diffMinutes >= 60) {
        const intervals = Math.floor(diffMinutes / 60);
        const newSavings = currentUser.savingsBalance * Math.pow(1.005, intervals);
        const yieldAmount = newSavings - currentUser.savingsBalance;

        if (intervals > 0) {
             await updateDoc(doc(db, "users", uid), {
                savingsBalance: newSavings,
                lastInterestDate: serverTimestamp() 
            });
            await addDoc(collection(db, "transactions"), {
                senderId: 'SYSTEM', senderName: 'Cofre Rendimento',
                receiverId: uid, receiverName: currentUser.name,
                amount: yieldAmount, type: 'interest_yield',
                timestamp: serverTimestamp(), participants: [uid]
            });
            showToast(`Rendimento da Poupança: +R$ ${yieldAmount.toFixed(2)}`);
        }
    }
}

function syncSystemData() {
    onSnapshot(doc(db, "users", CITY_HALL_ID), (snap) => {
        if(snap.exists()) {
            const data = snap.data();
            currentTaxRate = data.customTax || 0.02;
            dailyRewardValue = data.dailyRewardAmount || 50;
            
            document.getElementById('city-hall-balance').innerText = `R$ ${data.balance.toFixed(2)}`;
            document.getElementById('total-tax-collected').innerText = `R$ ${(data.totalTaxCollected || 0).toFixed(2)}`;
            document.getElementById('tax-display').innerText = (currentTaxRate*100).toFixed(1) + "%";
            
            if(currentUser && (currentUser.role === 'admin' || currentUser.uid === CITY_HALL_ID)) {
                updateSliderUI(currentTaxRate * 100);
            }
        }
    });

    const q = query(collection(db, "polls"), where("status", "==", "open"));
    onSnapshot(q, (snap) => {
        const list = document.getElementById('polls-list');
        list.innerHTML = "";
        snap.forEach(docSnap => {
            const p = docSnap.data();
            const percent = Math.min(100, (p.votes / p.targetVotes) * 100);
            
            const div = document.createElement('div');
            div.className = 'poll-card';
            div.innerHTML = `
                <div style="display:flex; justify-content:space-between">
                    <strong>${p.title}</strong>
                    <span>R$ ${p.cost}</span>
                </div>
                <div class="poll-progress"><div class="poll-bar" style="width:${percent}%"></div></div>
                <div style="display:flex; justify-content:space-between; align-items:center">
                    <small>${p.votes} / ${p.targetVotes} votos</small>
                    <button onclick="votePoll('${docSnap.id}')" style="width:auto; padding:5px 15px; margin:0">Votar</button>
                </div>
            `;
            list.appendChild(div);
        });
    });
}

// FUNÇÕES DE INVESTIMENTO E POUPANÇA
window.savingsAction = async (type) => {
    let amount = prompt(`Valor para ${type === 'deposit' ? 'Guardar' : 'Sacar'}:`);
    amount = parseFloat(amount);
    if(!amount || amount <= 0) return;

    if (type === 'deposit') {
        if (currentUser.balance < amount) return showToast("Saldo insuficiente", "error");
        await updateDoc(doc(db, "users", currentUser.uid), {
            balance: increment(-amount),
            savingsBalance: increment(amount)
        });
    } else {
        if (currentUser.savingsBalance < amount) return showToast("Saldo no cofre insuficiente", "error");
        await updateDoc(doc(db, "users", currentUser.uid), {
            balance: increment(amount),
            savingsBalance: increment(-amount)
        });
    }
    showToast("Operação no Cofre realizada!");
};

function initStockMarket() {
    setInterval(() => {
        const now = Date.now();
        const timeSeed = Math.floor(now / 10000); 
        const basePrice = 50; 
        const variation = Math.sin(timeSeed) * 20;
        const price = basePrice + variation + (Math.random()*2); 
        
        const priceEl = document.getElementById('stock-price');
        const oldPrice = parseFloat(priceEl.innerText.replace('R$ ', '').replace(',','.'));
        
        priceEl.innerText = `R$ ${price.toFixed(2)}`;
        
        const trendEl = document.getElementById('stock-trend');
        if(price > oldPrice) { trendEl.innerHTML = "▲"; trendEl.className = "trend-up"; trendEl.style.color = "var(--accent)"; }
        else { trendEl.innerHTML = "▼"; trendEl.className = "trend-down"; trendEl.style.color = "var(--danger)"; }
        
        window.currentStockPrice = price;
    }, 5000);
}

window.tradeStock = async (action) => {
    const price = window.currentStockPrice;
    if(!price) return;
    
    if(action === 'buy') {
        if(currentUser.balance < price) return showToast("Saldo insuficiente", "error");
        await updateDoc(doc(db, "users", currentUser.uid), {
            balance: increment(-price),
            "stocks.glasscoin": increment(1)
        });
        showToast("Ação comprada!");
    } else {
        if(!currentUser.stocks?.glasscoin || currentUser.stocks.glasscoin < 1) return showToast("Você não tem ações", "error");
        await updateDoc(doc(db, "users", currentUser.uid), {
            balance: increment(price),
            "stocks.glasscoin": increment(-1)
        });
        showToast("Ação vendida!");
    }
};

function checkDailyRewardStatus() {
    const area = document.getElementById('daily-reward-area');
    const now = new Date();
    const last = currentUser.lastDailyClaim ? currentUser.lastDailyClaim.toDate() : new Date(0);
    const diffHours = (now - last) / (1000 * 60 * 60);

    if (diffHours >= 24) area.classList.remove('hidden');
    else area.classList.add('hidden');
}

window.claimDailyReward = async () => {
    try {
        await runTransaction(db, async (t) => {
            const cityRef = doc(db, "users", CITY_HALL_ID);
            const userRef = doc(db, "users", currentUser.uid);
            
            const cityDoc = await t.get(cityRef);
            if(cityDoc.data().balance < dailyRewardValue) throw "Prefeitura sem verba para auxílio!";

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
        showToast(`Recebeu R$ ${dailyRewardValue}!`);
        document.getElementById('daily-reward-area').classList.add('hidden');
    } catch(e) { showToast(e, 'error'); }
};

// --- FUNÇÕES FALTANTES ADICIONADAS ---

window.checkNotifications = () => {
    showToast("Você não tem novas notificações no momento.", "success");
};

window.takeLoan = async () => {
    const loanInput = document.getElementById('loan-amount-input');
    const amount = parseFloat(loanInput.value);
    
    if(!amount || amount <= 0 || amount > 5000) {
        return showToast("Valor inválido. O limite é R$ 5.000,00", "error");
    }

    // Como é uma simulação, libera o empréstimo mas adiciona ao saldo negativo base
    // Isso acionará a lógica de dívida de 5% a cada 10min
    await updateDoc(doc(db, "users", currentUser.uid), {
        balance: increment(amount),
        loanDebt: increment(amount) // Apenas registro visual se quiser adicionar depois
    });

    await addDoc(collection(db, "transactions"), {
        senderId: 'SYSTEM', senderName: 'Empréstimo Aprovado',
        receiverId: currentUser.uid, receiverName: currentUser.name,
        amount: amount, type: 'loan',
        timestamp: serverTimestamp(), participants: [currentUser.uid]
    });

    showToast(`Empréstimo de R$ ${amount.toFixed(2)} depositado! Cuidado com os juros.`, "success");
    loanInput.value = '';
    navTo('dashboard');
};

window.generateQR = () => {
    const amount = document.getElementById('qr-amount').value;
    const qrImage = document.getElementById('qr-image');
    if (amount && currentUser) {
        // Usando a API gratuita de QR Code para gerar a imagem
        const qrData = `${currentUser.shortId}:${amount}`;
        qrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrData)}`;
        qrImage.style.display = 'block';
    } else {
        qrImage.style.display = 'none';
    }
};

window.startScanner = () => {
    if (!html5QrcodeScanner) {
        // Verifica se a biblioteca foi carregada pelo HTML
        if(typeof Html5QrcodeScanner !== 'undefined') {
            html5QrcodeScanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: {width: 250, height: 250} }, false);
            html5QrcodeScanner.render((decodedText) => {
                const parts = decodedText.split(':');
                document.getElementById('dest-id').value = parts[0] || '';
                if(parts[1]) document.getElementById('amount').value = parts[1];
                navTo('transfer');
            }, (error) => { /* ignora avisos de scan enquanto não foca */ });
        } else {
            showToast("Erro: Leitor de QR Code não carregado.", "error");
        }
    }
};

window.stopScanner = () => {
    if (html5QrcodeScanner) {
        html5QrcodeScanner.clear().catch(e => console.error("Falha ao limpar scanner", e));
        html5QrcodeScanner = null;
    }
};

window.initAdminPanel = () => {
    updateSliderUI(currentTaxRate * 100);
    document.getElementById('admin-daily-reward').value = dailyRewardValue;
};

// --- ADMIN FEATURES ---
const slider = document.getElementById('tax-slider');
const taxText = document.getElementById('tax-psychology');
const taxValDisplay = document.getElementById('tax-value-display');

slider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    taxValDisplay.innerText = val + "%";
    updateSliderUI(val);
});

function updateSliderUI(val) {
    slider.value = val;
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

window.updateGlobalTax = async () => {
    const val = parseFloat(slider.value) / 100;
    await updateDoc(doc(db, "users", CITY_HALL_ID), { customTax: val });
    showToast("Taxa Atualizada!");
};

window.updateDailyReward = async () => {
    const val = parseFloat(document.getElementById('admin-daily-reward').value);
    if(val > 0) {
        await updateDoc(doc(db, "users", CITY_HALL_ID), { dailyRewardAmount: val });
        showToast("Valor do Auxílio Atualizado!");
    }
};

window.createPoll = async () => {
    const title = document.getElementById('poll-title').value;
    const cost = parseFloat(document.getElementById('poll-cost').value);
    const target = parseInt(document.getElementById('poll-target').value);
    
    if(!title || !cost || !target) return showToast("Preencha todos os campos", "error");

    await addDoc(collection(db, "polls"), {
        title, cost, targetVotes: target, votes: 0, status: 'open', voters: []
    });
    showToast("Enquete Publicada");
    
    document.getElementById('poll-title').value = '';
    document.getElementById('poll-cost').value = '';
    document.getElementById('poll-target').value = '';
};

window.votePoll = async (pollId) => {
    const pollRef = doc(db, "polls", pollId);
    const snap = await getDoc(pollRef);
    const data = snap.data();

    if(data.voters.includes(currentUser.uid)) return showToast("Você já votou!", "error");

    await runTransaction(db, async (t) => {
        const pDoc = await t.get(pollRef);
        const cityRef = doc(db, "users", CITY_HALL_ID);
        const cityDoc = await t.get(cityRef);
        
        let newVotes = pDoc.data().votes + 1;
        let newVoters = [...pDoc.data().voters, currentUser.uid];
        let newStatus = 'open';

        if (newVotes >= pDoc.data().targetVotes) {
            if (cityDoc.data().balance >= pDoc.data().cost) {
                t.update(cityRef, { balance: increment(-pDoc.data().cost) });
                newStatus = 'funded'; 
            }
        }
        
        t.update(pollRef, { votes: newVotes, voters: newVoters, status: newStatus });
    });
    showToast("Voto computado!");
};

// --- TRANSAÇÕES ---
async function transferLogic(shortId, amount) {
    try {
        const q = query(collection(db, "users"), where("shortId", "==", shortId));
        const receiverSnap = await getDocs(q);
        if(receiverSnap.empty) throw "Destinatário não encontrado";
        const receiverUid = receiverSnap.docs[0].id;
        if(receiverUid === currentUser.uid) throw "Erro: Mesmo usuário";

        await runTransaction(db, async (t) => {
            const senderRef = doc(db, "users", currentUser.uid);
            const receiverRef = doc(db, "users", receiverUid);
            const cityRef = doc(db, "users", CITY_HALL_ID);

            const sDoc = await t.get(senderRef);
            const rDoc = await t.get(receiverRef);
            const cDoc = await t.get(cityRef);

            let taxRate = cDoc.exists() ? (cDoc.data().customTax || 0.02) : 0.02;
            let tax = amount * taxRate;
            let total = amount + tax;

            if(sDoc.data().balance < total) throw "Saldo Insuficiente";

            t.update(senderRef, { balance: increment(-total) });
            t.update(receiverRef, { balance: increment(amount) });
            if(cDoc.exists()) {
                t.update(cityRef, { 
                    balance: increment(tax),
                    totalTaxCollected: increment(tax) 
                });
            }

            const txRef = doc(collection(db, "transactions"));
            t.set(txRef, {
                senderId: currentUser.uid, senderName: currentUser.name,
                receiverId: receiverUid, receiverName: rDoc.data().name,
                amount: amount, tax: tax, type: 'transfer',
                timestamp: serverTimestamp(), participants: [currentUser.uid, receiverUid]
            });
        });
        showToast("Transferência realizada!");
        navTo('dashboard');
        document.getElementById('transfer-form').reset();
    } catch (e) { showToast(e, 'error'); }
}

document.getElementById('transfer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = document.getElementById('dest-id').value.toUpperCase();
    const amt = parseFloat(document.getElementById('amount').value);
    pendingTransaction = { id, amt };
    document.getElementById('pin-modal').classList.remove('hidden');
});

document.getElementById('confirm-pin-btn').addEventListener('click', () => {
    if(document.getElementById('confirm-pin-input').value === currentUser.pin) {
        transferLogic(pendingTransaction.id, pendingTransaction.amt);
        closeModal('pin-modal');
    } else showToast("PIN Incorreto", "error");
    document.getElementById('confirm-pin-input').value = '';
});

// --- HISTÓRICO & FILTROS CORRIGIDOS ---
function listenToTransactions(uid) {
    const q = query(collection(db, "transactions"), where("participants", "array-contains", uid), orderBy("timestamp", "desc"), limit(30));
    onSnapshot(q, (snap) => {
        currentTransactions = [];
        snap.forEach(d => currentTransactions.push({...d.data(), id: d.id}));
        // Captura o chip ativo atual para manter o filtro ao atualizar
        const activeChip = document.querySelector('.filter-chips button.active-chip');
        const filterType = activeChip ? activeChip.dataset.filter : 'all';
        renderHistory(filterType);
    });
}

window.filterHistory = (filter) => {
    // Corrige o erro do uso obsoleto de 'event.target' que quebrava o JavaScript
    const event = window.event;
    if(event) {
        document.querySelectorAll('.filter-chips button').forEach(b => b.classList.remove('active-chip'));
        event.currentTarget.classList.add('active-chip');
        event.currentTarget.dataset.filter = filter; // salva estado do filtro
    }
    renderHistory(filter);
};

function renderHistory(filter) {
    const list = document.getElementById('transaction-list');
    list.innerHTML = "";
    
    currentTransactions.forEach(t => {
        const isSender = t.senderId === currentUser.uid;
        
        if(filter === 'in' && isSender) return;
        if(filter === 'out' && !isSender) return;
        if(filter === 'tax' && t.type !== 'tax' && t.amount > 0) return; 

        const li = document.createElement('li');
        let icon = isSender ? 'arrow-up' : 'arrow-down';
        let color = isSender ? '#ff416c' : '#00f260';
        let signal = isSender ? '-' : '+';
        
        if (t.type === 'interest_debt') { icon = 'fire'; color = '#e74c3c'; signal = '-'; }
        if (t.type === 'interest_yield') { icon = 'leaf'; color = '#f1c40f'; signal = '+'; }
        if (t.type === 'welfare') { icon = 'gift'; color = '#3498db'; signal = '+'; }
        if (t.type === 'loan') { icon = 'hand-holding-usd'; color = '#8e2de2'; signal = '+'; }

        li.innerHTML = `
            <div>
                <i class="fas fa-${icon}" style="color:${color}; margin-right:10px;"></i>
                <strong>${t.type === 'transfer' ? (isSender ? t.receiverName : t.senderName) : t.senderName}</strong>
                <br><small style="opacity:0.6">${t.type.toUpperCase()}</small>
            </div>
            <div style="color:${color}">${signal} R$ ${t.amount.toFixed(2)}</div>
        `;
        list.appendChild(li);
    });
}
