import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, updateDoc, collection, query, where, onSnapshot, runTransaction, serverTimestamp, orderBy, limit, getDocs, Timestamp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";

// --- CONFIGURAÇÃO FIREBASE ---
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
let currentTaxRate = 0.02; // 2% padrão
let html5QrcodeScanner = null;
let pendingTransaction = null; // Armazena dados enquanto aguarda PIN

// =========================================================
// ⚠️ CONFIGURE AQUI O UID DA CONTA DA PREFEITURA
const CITY_HALL_ID = "COLE_O_UID_DA_PREFEITURA_AQUI"; 
// =========================================================

// --- SONS ---
const playSound = (type) => {
    const id = type === 'success' ? 'snd-success' : type === 'error' ? 'snd-error' : 'snd-click';
    const audio = document.getElementById(id);
    if(audio) { audio.currentTime = 0; audio.play().catch(e => {}); }
};

// --- FUNÇÕES UTILITÁRIAS ---
const showToast = (msg, type = 'success') => {
    playSound(type);
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerText = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
};

window.navTo = (sectionId) => {
    playSound('click');
    document.querySelectorAll('section').forEach(s => s.classList.remove('active-section'));
    document.querySelectorAll('section').forEach(s => s.classList.add('hidden'));
    
    const target = document.getElementById(sectionId + '-section');
    if(target) {
        target.classList.remove('hidden');
        target.classList.add('active-section');
    }
    
    if(sectionId === 'qr-scan') startScanner();
    else stopScanner();
};

window.closeModal = (id) => {
    document.getElementById(id).classList.add('hidden');
    pendingTransaction = null; // Limpa transação pendente
};

window.toggleAuth = (mode) => {
    const isReg = mode === 'register';
    document.getElementById('fullname').style.display = isReg ? 'block' : 'none';
    document.getElementById('role-select').style.display = isReg ? 'block' : 'none';
    document.getElementById('reg-pin').style.display = isReg ? 'block' : 'none';
    document.getElementById('auth-btn').innerText = isReg ? 'Cadastrar' : 'Entrar';
    document.getElementById('auth-form').dataset.mode = mode;
};

// --- SISTEMA DE ID E PIN ---
function generateShortId() {
    const chars = "ABCDEF0123456789";
    let res = "";
    for(let i=0; i<6; i++) res += chars.charAt(Math.floor(Math.random() * chars.length));
    return res;
}

// --- AUTENTICAÇÃO ---
const authForm = document.getElementById('auth-form');
authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
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
            
            // Cria Documento do Usuário
            await setDoc(doc(db, "users", userCred.user.uid), {
                name: name, email: email, role: role, pin: pin,
                shortId: generateShortId(),
                balance: 1000.00,
                status: 'active',
                lastInterestDate: serverTimestamp(),
                createdAt: serverTimestamp()
            });
            showToast("Conta criada com sucesso!");
        } else {
            await signInWithEmailAndPassword(auth, email, password);
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
});

onAuthStateChanged(auth, (user) => {
    if (user) {
        document.getElementById('auth-section').classList.remove('active-section');
        navTo('dashboard');
        initializeUser(user.uid);
    } else {
        navTo('auth');
        document.getElementById('auth-section').classList.add('active-section');
        currentUser = null;
    }
});

document.getElementById('logout-btn').addEventListener('click', () => signOut(auth));

// --- LÓGICA DO USUÁRIO ---
function initializeUser(uid) {
    // Escuta mudanças no usuário
    onSnapshot(doc(db, "users", uid), (docSnap) => {
        if (docSnap.exists()) {
            currentUser = docSnap.data();
            currentUser.uid = uid;

            // Checa Banimento
            if(currentUser.status === 'banned') {
                alert("Esta conta foi banida permanentemente.");
                signOut(auth);
                return;
            }

            // Atualiza UI
            document.getElementById('user-name').innerText = currentUser.name;
            document.getElementById('user-role').innerText = currentUser.role === 'admin' ? 'Prefeitura' : 'Cidadão';
            document.getElementById('user-balance').innerText = `R$ ${currentUser.balance.toFixed(2)}`;
            document.getElementById('user-short-id').innerText = currentUser.shortId;
            document.getElementById('user-avatar').src = `https://ui-avatars.com/api/?name=${currentUser.name}&background=random&color=fff`;

            // Badge de Empréstimo
            const loanBadge = document.getElementById('loan-indicator');
            loanBadge.style.display = currentUser.balance < 0 ? 'inline-block' : 'none';

            // Botão Admin
            if(currentUser.role === 'admin') {
                document.getElementById('admin-btn').classList.remove('hidden');
                initAdminPanel();
            }

            // Aplica Juros se necessário
            checkAndApplyInterest(uid, currentUser);
        }
    });

    listenToTransactions(uid);
    syncGlobalTax();
}

// --- JUROS SOBRE EMPRÉSTIMO ---
async function checkAndApplyInterest(uid, userData) {
    if(userData.balance >= 0) return; // Só aplica se estiver devendo
    
    const now = new Date();
    const lastDate = userData.lastInterestDate ? userData.lastInterestDate.toDate() : new Date();
    const diffMinutes = (now - lastDate) / 1000 / 60;

    // Se passou 10 minutos
    if(diffMinutes >= 10) {
        const interestRate = 0.05; // 5%
        const debt = Math.abs(userData.balance);
        const interest = debt * interestRate;
        const newBalance = userData.balance - interest; // Aumenta a dívida

        try {
            await updateDoc(doc(db, "users", uid), {
                balance: newBalance,
                lastInterestDate: serverTimestamp()
            });
            showToast(`Juros aplicados: R$ ${interest.toFixed(2)}`, 'error');
        } catch(e) { console.log("Erro juros", e); }
    }
}

// --- SISTEMA DE EMPRÉSTIMOS ---
window.takeLoan = async () => {
    const amount = parseFloat(document.getElementById('loan-amount-input').value);
    const limit = 5000; // Limite fixo de empréstimo para simplificar
    
    if(!amount || amount <= 0) return showToast("Valor inválido", "error");
    if((currentUser.balance + amount) > limit) return showToast("Limite de empréstimo excedido (Max saldo final 5000)", "error");

    try {
        await updateDoc(doc(db, "users", currentUser.uid), {
            balance: currentUser.balance + amount
        });
        
        // Registra transação de empréstimo
        await setDoc(doc(collection(db, "transactions")), {
            type: 'loan',
            userId: currentUser.uid,
            amount: amount,
            timestamp: serverTimestamp()
        });

        showToast(`Empréstimo de R$ ${amount} recebido!`);
        navTo('dashboard');
    } catch(e) {
        showToast("Erro ao pegar empréstimo", "error");
    }
};

// --- GESTÃO DE TAXAS E PREFEITURA ---
function syncGlobalTax() {
    // Tenta ler a taxa da prefeitura. Se não conseguir, usa padrão.
    if(CITY_HALL_ID.length > 5) {
        onSnapshot(doc(db, "users", CITY_HALL_ID), (snap) => {
            if(snap.exists()) {
                currentTaxRate = snap.data().customTax || 0.02;
                document.getElementById('tax-display').innerText = (currentTaxRate*100).toFixed(1) + "%";
                document.getElementById('admin-tax-rate').value = (currentTaxRate*100);
                document.getElementById('city-hall-balance').innerText = `R$ ${snap.data().balance.toFixed(2)}`;
            }
        });
    }
}

window.updateGlobalTax = async () => {
    const val = parseFloat(document.getElementById('admin-tax-rate').value);
    if(isNaN(val) || val < 0) return showToast("Taxa inválida", "error");
    
    try {
        await updateDoc(doc(db, "users", CITY_HALL_ID), { customTax: val / 100 });
        showToast("Taxa atualizada!");
    } catch(e) { showToast("Erro (Você é a prefeitura?)", "error"); }
};

window.banUser = async () => {
    const shortId = document.getElementById('ban-user-id').value;
    const q = query(collection(db, "users"), where("shortId", "==", shortId));
    const snap = await getDocs(q);
    
    if(snap.empty) return showToast("Usuário não encontrado", "error");
    
    const targetUid = snap.docs[0].id;
    await updateDoc(doc(db, "users", targetUid), { status: "banned" });
    showToast("Usuário BANIDO com sucesso.");
};

// --- TRANSAÇÕES SEGURAS ---

// 1. Preparação
const transferForm = document.getElementById('transfer-form');
transferForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const destId = document.getElementById('dest-id').value.toUpperCase();
    const amount = parseFloat(document.getElementById('amount').value);

    if(amount <= 0) return showToast("Valor inválido", "error");

    // Checa limite de 30k
    const recentTotal = await checkTransactionLimit(currentUser.uid);
    if(recentTotal + amount > 30000) {
        document.getElementById('limit-warning').classList.remove('hidden');
        return showToast("Limite de R$ 30.000 / 15min excedido!", "error");
    }

    // Salva estado e pede PIN
    pendingTransaction = { destId, amount };
    document.getElementById('pin-modal').classList.remove('hidden');
    document.getElementById('confirm-pin-input').value = "";
    document.getElementById('confirm-pin-input').focus();
});

// 2. Confirmação de PIN
document.getElementById('confirm-pin-btn').addEventListener('click', async () => {
    const inputPin = document.getElementById('confirm-pin-input').value;
    
    if(inputPin !== currentUser.pin) {
        playSound('error');
        return showToast("PIN Incorreto!", "error");
    }

    // PIN Correto -> Executa
    closeModal('pin-modal');
    executeTransaction(pendingTransaction.destId, pendingTransaction.amount);
});

// 3. Execução
async function executeTransaction(shortId, amount) {
    try {
        const q = query(collection(db, "users"), where("shortId", "==", shortId));
        const receiverSnap = await getDocs(q);
        
        if(receiverSnap.empty) throw new Error("Destinatário não encontrado.");
        
        const receiverDoc = receiverSnap.docs[0];
        const receiverUid = receiverDoc.id;
        
        if(receiverUid === currentUser.uid) throw new Error("Auto-envio proibido.");

        const tax = amount * currentTaxRate;
        const totalDed = amount + tax;

        await runTransaction(db, async (transaction) => {
            const senderRef = doc(db, "users", currentUser.uid);
            const senderDoc = await transaction.get(senderRef);
            
            if(senderDoc.data().balance < totalDed) throw "Saldo insuficiente (Valor + Taxa)";

            const receiverRef = doc(db, "users", receiverUid);
            const cityRef = doc(db, "users", CITY_HALL_ID);
            
            // Atualiza saldos
            transaction.update(senderRef, { balance: senderDoc.data().balance - totalDed });
            transaction.update(receiverRef, { balance: receiverDoc.data().balance + amount });
            
            // Paga prefeitura (se existir e documento estiver criado)
            const cityDoc = await transaction.get(cityRef);
            if(cityDoc.exists()) {
                transaction.update(cityRef, { balance: cityDoc.data().balance + tax });
            }

            // Cria recibo
            const txRef = doc(collection(db, "transactions"));
            transaction.set(txRef, {
                senderId: currentUser.uid,
                senderName: currentUser.name,
                receiverId: receiverUid,
                receiverName: receiverDoc.data().name,
                amount: amount,
                tax: tax,
                timestamp: serverTimestamp(),
                participants: [currentUser.uid, receiverUid]
            });
        });

        showToast("Transferência Realizada!", "success");
        navTo('dashboard');
        document.getElementById('transfer-form').reset();
    } catch(e) {
        showToast(e.message || e, "error");
    }
}

// 4. Checagem de Limite
async function checkTransactionLimit(uid) {
    const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
    const q = query(
        collection(db, "transactions"),
        where("senderId", "==", uid),
        where("timestamp", ">", fifteenMinsAgo)
    );
    
    const snap = await getDocs(q);
    let total = 0;
    snap.forEach(d => total += d.data().amount);
    return total;
}

// --- HISTÓRICO E COMPROVANTE ---
function listenToTransactions(uid) {
    const q = query(
        collection(db, "transactions"), 
        where("participants", "array-contains", uid),
        orderBy("timestamp", "desc"),
        limit(20)
    );

    onSnapshot(q, (snap) => {
        const list = document.getElementById('transaction-list');
        list.innerHTML = "";
        snap.forEach(docSnap => {
            const t = docSnap.data();
            const isSender = t.senderId === uid;
            
            const li = document.createElement('li');
            li.innerHTML = `
                <div>
                    <strong>${isSender ? 'Enviou para' : 'Recebeu de'} ${isSender ? t.receiverName : t.senderName}</strong><br>
                    <small>${t.timestamp ? t.timestamp.toDate().toLocaleDateString() : 'Agora'}</small>
                </div>
                <div style="color:${isSender ? '#ff416c' : '#00f260'}">
                    ${isSender ? '-' : '+'} R$ ${t.amount.toFixed(2)}
                </div>
            `;
            // Clique para ver recibo
            li.onclick = () => showReceipt(t, docSnap.id);
            list.appendChild(li);
        });
    });
}

function showReceipt(data, id) {
    document.getElementById('receipt-modal').classList.remove('hidden');
    document.getElementById('rcpt-amount').innerText = `R$ ${data.amount.toFixed(2)}`;
    document.getElementById('rcpt-date').innerText = data.timestamp ? data.timestamp.toDate().toLocaleString() : "Processando...";
    document.getElementById('rcpt-sender').innerText = data.senderName;
    document.getElementById('rcpt-receiver').innerText = data.receiverName;
    document.getElementById('rcpt-id').innerText = id;
}

// --- QR CODE (API) ---
window.generateQR = () => {
    const amt = document.getElementById('qr-amount').value;
    const img = document.getElementById('qr-image');
    const ph = document.getElementById('qr-placeholder');
    
    if(!amt) {
        img.style.display = 'none';
        ph.style.display = 'block';
        return;
    }

    const payload = JSON.stringify({ sid: currentUser.shortId, amt: parseFloat(amt) });
    // API Externa (Infalível)
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(payload)}`;
    img.style.display = 'block';
    ph.style.display = 'none';
};

// --- SCANNER ---
function startScanner() {
    html5QrcodeScanner = new Html5Qrcode("reader");
    html5QrcodeScanner.start(
        { facingMode: "environment" }, 
        { fps: 10, qrbox: 250 },
        async (decodedText) => {
            try {
                const data = JSON.parse(decodedText);
                if(data.sid && data.amt) {
                    stopScanner();
                    playSound('success'); // Bip de leitura
                    
                    // Busca nome do destinatário
                    const q = query(collection(db, "users"), where("shortId", "==", data.sid));
                    const snap = await getDocs(q);
                    const name = snap.empty ? "Desconhecido" : snap.docs[0].data().name;

                    // Mostra modal de confirmação do scan
                    document.getElementById('scan-result').classList.remove('hidden');
                    document.getElementById('scan-amt').innerText = data.amt;
                    document.getElementById('scan-to-name').innerText = name;
                    
                    // Configura botão de pagar (pede PIN depois)
                    const payBtn = document.getElementById('scan-pay-btn');
                    payBtn.onclick = () => {
                        document.getElementById('scan-result').classList.add('hidden');
                        // Preenche formulário de transferência e inicia processo
                        pendingTransaction = { destId: data.sid, amount: parseFloat(data.amt) };
                        document.getElementById('pin-modal').classList.remove('hidden');
                    };
                }
            } catch(e) { console.log("Lendo..."); }
        }
    ).catch(e => showToast("Erro Câmera", "error"));
}

function stopScanner() {
    if(html5QrcodeScanner) {
        html5QrcodeScanner.stop().then(() => html5QrcodeScanner.clear()).catch(()=>{});
    }
}

window.resetScanner = () => {
    document.getElementById('scan-result').classList.add('hidden');
    startScanner();
};